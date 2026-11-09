import type {
  ConverseCommandInput,
  ConverseCommandOutput,
  Message,
} from "@aws-sdk/client-bedrock-runtime";
import { createHash, randomUUID } from "node:crypto";
import type { AppConfig } from "./config";
import { SERVICE_NAME, loadConfig } from "./config";
import {
  AwsBedrockConverseClient,
  extractResponseText,
  type BedrockConverseClient,
} from "./bedrockClient";
import {
  createTurnSortKey,
  DynamoDbChatRepository,
  type ChatRepository,
} from "./chatRepository";
import { jsonResponse } from "./response";
import { converseWithTools, ToolConversationError, type ToolConversationStats } from "./toolConversation";
import type {
  ChatHistoryTurn,
  ChatSuccessResponseBody,
  ChatTurnItem,
  HttpEvent,
  LambdaResponse,
} from "./types";
import {
  CHAT_REQUEST_LIMITS,
  INVALID_CHAT_REQUEST_ERROR,
  InvalidChatRequestError,
  numberInRange,
  optionalIntegerInRange,
  optionalNumberInRange,
  parseJsonBody,
  optionalTrimmedString,
  requiredTrimmedString,
} from "./validation";

export interface ChatDependencies {
  config?: AppConfig;
  repository?: ChatRepository;
  bedrockClient?: BedrockConverseClient;
  generateSessionId?: () => string;
  generateTurnId?: () => string;
  nowMs?: () => number;
}

export async function handleChat(
  event: HttpEvent,
  dependencies: ChatDependencies = {},
  getRemainingTimeMs?: () => number,
): Promise<LambdaResponse> {
  const startedAt = (dependencies.nowMs ?? Date.now)();
  let telemetryContext: ChatTelemetryContext | undefined;
  let toolStats: ToolConversationStats | undefined;

  try {
    const config = dependencies.config ?? loadConfig();

    if (!config.chatTable) {
      throw new ChatServiceError("ConfigurationError");
    }

    const userId = extractAuthenticatedUserId(event);
    const payload = parseJsonBody(event);

    // Enable runbook execution only after the RAG implementation is complete.
    if (payload.mode === "runbook") {
      throw new InvalidChatRequestError();
    }

    const sessionId =
      optionalTrimmedString(payload.session_id, {
        maxLength: CHAT_REQUEST_LIMITS.sessionIdMaxLength,
      }) ??
      (dependencies.generateSessionId ?? randomUUID)();
    const prompt = requiredTrimmedString(payload.prompt, {
      maxLength: CHAT_REQUEST_LIMITS.promptMaxLength,
    });

    const systemPrompt = optionalTrimmedString(payload.system_prompt, {
      maxLength: CHAT_REQUEST_LIMITS.systemPromptMaxLength,
    });
    const modelId = config.modelId;
    const historyTurns = optionalIntegerInRange(
      payload.history_turns,
      config.historyTurns,
      CHAT_REQUEST_LIMITS.historyTurnsMin,
      CHAT_REQUEST_LIMITS.historyTurnsMax,
    );
    const maxTokens = optionalIntegerInRange(
      payload.max_tokens,
      config.maxTokens,
      CHAT_REQUEST_LIMITS.maxTokensMin,
      CHAT_REQUEST_LIMITS.maxTokensMax,
    );

    if (payload.temperature !== undefined && payload.top_p !== undefined) {
      throw new InvalidChatRequestError();
    }

    const temperature = optionalNumberInRange(
      payload.temperature,
      config.temperature,
      CHAT_REQUEST_LIMITS.temperatureMin,
      CHAT_REQUEST_LIMITS.temperatureMax,
    );
    const topP = payload.top_p === undefined
      ? undefined
      : numberInRange(
        payload.top_p,
        CHAT_REQUEST_LIMITS.topPMin,
        CHAT_REQUEST_LIMITS.topPMax,
      );

    const repository =
      dependencies.repository ??
      new DynamoDbChatRepository(config.chatTable, config.awsRegion);
    const bedrockClient =
      dependencies.bedrockClient ?? new AwsBedrockConverseClient(config.awsRegion, config.toolCallingEnabled);

    telemetryContext = {
      environment: config.environment,
      modelId,
      requestId: event.requestContext?.requestId,
      userHash: stableHash(userId),
      sessionHash: stableHash(sessionId),
    };
    emitMetrics({
      context: telemetryContext,
      metrics: [{ name: "ChatRequestCount", unit: "Count", value: 1 }],
    });

    const history = await repository.queryHistoryTurns(userId, sessionId, historyTurns);
    const boundedContext = buildBoundedContextMessages(history, prompt, config.maxContextChars);

    const bedrockRequest: ConverseCommandInput = {
      modelId,
      messages: boundedContext.messages,
      inferenceConfig: {
        maxTokens,
        ...(topP === undefined ? { temperature } : { topP }),
      },
    };

    if (systemPrompt) {
      bedrockRequest.system = [{ text: systemPrompt }];
    }

    const bedrockStartedAt = (dependencies.nowMs ?? Date.now)();
    let responseText: string;
    let usage: ConverseCommandOutput["usage"];
    let stopReason: ConverseCommandOutput["stopReason"];
    if (config.toolCallingEnabled) {
      toolStats = { requests: 0, rounds: 0, failures: 0, bedrockLatencyMs: 0 };
      ({ text: responseText, usage, stopReason } = await converseWithTools({
        client: bedrockClient,
        request: bedrockRequest,
        stats: toolStats,
        nowMs: dependencies.nowMs,
        getRemainingTimeMs,
      }));
    } else {
      const bedrockResponse = await bedrockClient.converse(bedrockRequest);
      if (bedrockResponse.stopReason === "tool_use" ||
          bedrockResponse.output?.message?.content?.some((block) => block?.toolUse !== undefined)) {
        throw new ToolConversationError("tool_protocol");
      }
      responseText = extractResponseText(bedrockResponse).trim();
      if (!responseText) {
        throw new ChatServiceError("EmptyBedrockResponse");
      }
      ({ usage, stopReason } = bedrockResponse);
    }
    const bedrockLatency = toolStats?.bedrockLatencyMs ??
      Math.max(0, (dependencies.nowMs ?? Date.now)() - bedrockStartedAt);
    const timestamp = (dependencies.nowMs ?? Date.now)();
    const turnId = (dependencies.generateTurnId ?? randomUUID)();

    await repository.saveTurn(createTurnItem({
      userId,
      sessionId,
      turnId,
      timestamp,
      prompt,
      responseText,
      modelId,
      usage,
      retentionDays: config.retentionDays,
    }));

    const latency = Math.max(0, timestamp - startedAt);
    logInfo("chat_request_succeeded", {
      ...telemetryContext,
      latencyMs: latency,
      bedrockLatencyMs: bedrockLatency,
      historyTurnCount: history.length,
      contextTruncated: boundedContext.truncated,
    });
    emitMetrics({
      context: telemetryContext,
      metrics: [
        { name: "ChatSuccessCount", unit: "Count", value: 1 },
        { name: "BedrockLatency", unit: "Milliseconds", value: bedrockLatency },
        ...usageMetrics(usage),
        ...toolMetrics(toolStats),
        ...(boundedContext.truncated
          ? [{ name: "ContextTruncatedCount", unit: "Count" as const, value: 1 }]
          : []),
      ],
    });

    const responseBody: ChatSuccessResponseBody = {
      session_id: sessionId,
      timestamp,
      response: responseText,
      usage: usage ?? {},
      stopReason,
    };

    return jsonResponse(200, responseBody);
  } catch (error) {
    const failure = classifyChatFailure(error);
    if (failure.category !== "invalid_request") {
      logChatError(error, failure.category, telemetryContext);
    }
    if (telemetryContext) {
      emitMetrics({
        context: telemetryContext,
        failureCategory: failure.category,
        metrics: [
          { name: "ChatFailureCount", unit: "Count", value: 1 },
          ...toolMetrics(toolStats),
          ...usageMetrics(toolStats?.usage),
          ...(toolStats
            ? [{ name: "BedrockLatency", unit: "Milliseconds" as const, value: toolStats.bedrockLatencyMs }]
            : []),
          ...(failure.category === "bedrock_retryable"
            ? [{ name: "BedrockThrottleCount", unit: "Count" as const, value: 1 }]
            : []),
        ],
      });
    }
    return jsonResponse(failure.statusCode, { error: failure.publicError });
  }
}

class ChatServiceError extends Error {
  constructor(name: string) {
    super(name);
    this.name = name;
  }
}

interface ChatFailure {
  statusCode: number;
  publicError: string;
  category: string;
}

function classifyChatFailure(error: unknown): ChatFailure {
  const errorName = getErrorName(error);

  if (error instanceof ToolConversationError) {
    return { statusCode: 502, publicError: "Chat request failed", category: error.category };
  }

  if (error instanceof UnauthorizedChatRequestError) {
    return {
      statusCode: 401,
      publicError: "Unauthorized",
      category: "unauthorized",
    };
  }

  if (error instanceof InvalidChatRequestError) {
    return {
      statusCode: 400,
      publicError: INVALID_CHAT_REQUEST_ERROR,
      category: "invalid_request",
    };
  }

  if (isBedrockThrottlingError(errorName)) {
    return {
      statusCode: 503,
      publicError: "Chat service temporarily unavailable",
      category: "bedrock_retryable",
    };
  }

  if (isBedrockAccessDeniedError(errorName)) {
    return {
      statusCode: 500,
      publicError: "Chat request failed",
      category: "bedrock_access_denied",
    };
  }

  if (isBedrockValidationError(errorName)) {
    return {
      statusCode: 502,
      publicError: "Chat request failed",
      category: "bedrock_validation",
    };
  }

  if (errorName === "EmptyBedrockResponse") {
    return {
      statusCode: 502,
      publicError: "Chat request failed",
      category: "bedrock_empty_response",
    };
  }

  return {
    statusCode: 500,
    publicError: "Chat request failed",
    category: "internal",
  };
}

function isBedrockThrottlingError(errorName: string): boolean {
  return [
    "ThrottlingException",
    "TooManyRequestsException",
    "ServiceUnavailableException",
    "ModelNotReadyException",
  ].includes(errorName);
}

function isBedrockAccessDeniedError(errorName: string): boolean {
  return ["AccessDeniedException", "UnauthorizedOperation"].includes(errorName);
}

function isBedrockValidationError(errorName: string): boolean {
  return ["ValidationException"].includes(errorName);
}

function getErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function getErrorStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) {
    return undefined;
  }

  const metadata = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
  return typeof metadata?.httpStatusCode === "number" ? metadata.httpStatusCode : undefined;
}

function logChatError(
  error: unknown,
  category: string,
  context: ChatTelemetryContext | undefined,
): void {
  const errorFields = error instanceof Error
    ? { errorName: error.name }
    : { errorName: "UnknownError" };
  const httpStatusCode = getErrorStatusCode(error);

  logError("chat_request_failed", {
    ...context,
    failureCategory: category,
    ...errorFields,
    ...(httpStatusCode === undefined ? {} : { httpStatusCode }),
  });
}

function createTextMessage(role: "user" | "assistant", text: string): Message {
  return { role, content: [{ text }] };
}

function extractAuthenticatedUserId(event: HttpEvent): string {
  const sub = event.requestContext?.authorizer?.jwt?.claims?.sub;
  if (typeof sub !== "string" || sub.trim().length === 0) {
    throw new UnauthorizedChatRequestError();
  }

  return sub.trim();
}

class UnauthorizedChatRequestError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedChatRequestError";
  }
}

export function buildBoundedContextMessages(
  history: ChatHistoryTurn[],
  currentPrompt: string,
  maxContextChars: number,
): { messages: Message[]; truncated: boolean } {
  const selected: ChatHistoryTurn[] = [];
  let usedChars = currentPrompt.length;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index];
    const turnChars = turn.prompt.length + turn.response.length;
    if (usedChars + turnChars <= maxContextChars) {
      selected.unshift(turn);
      usedChars += turnChars;
    } else {
      break;
    }
  }

  const messages = selected.flatMap((turn) => [
    createTextMessage("user", turn.prompt),
    createTextMessage("assistant", turn.response),
  ]);
  messages.push(createTextMessage("user", currentPrompt));

  return {
    messages,
    truncated: selected.length !== history.length,
  };
}

function createTurnItem(input: {
  userId: string;
  sessionId: string;
  turnId: string;
  timestamp: number;
  prompt: string;
  responseText: string;
  modelId: string;
  usage: ConverseCommandOutput["usage"];
  retentionDays: number;
}): ChatTurnItem {
  const item: ChatTurnItem = {
    user_id: input.userId,
    session_id: input.sessionId,
    sk: createTurnSortKey(input.sessionId, input.timestamp, input.turnId),
    timestamp: input.timestamp,
    prompt: input.prompt,
    response: input.responseText,
    model_id: input.modelId,
    expires_at: Math.floor(input.timestamp / 1000) + input.retentionDays * 24 * 60 * 60,
  };

  const { usage } = input;
  if (typeof usage?.inputTokens === "number" && Number.isFinite(usage.inputTokens)) {
    item.input_tokens = Number(usage.inputTokens);
  }

  if (typeof usage?.outputTokens === "number" && Number.isFinite(usage.outputTokens)) {
    item.output_tokens = Number(usage.outputTokens);
  }

  return item;
}

interface ChatTelemetryContext {
  environment: string;
  modelId: string;
  requestId?: string;
  userHash: string;
  sessionHash: string;
}

interface MetricValue {
  name: string;
  unit: "Count" | "Milliseconds";
  value: number;
}

function usageMetrics(usage: ConverseCommandOutput["usage"]): MetricValue[] {
  return [
    { name: "InputTokens", unit: "Count", value: usage?.inputTokens },
    { name: "OutputTokens", unit: "Count", value: usage?.outputTokens },
    { name: "TotalTokens", unit: "Count", value: usage?.totalTokens },
  ].filter((metric): metric is MetricValue => (
    typeof metric.value === "number" && Number.isFinite(metric.value)
  ));
}

function toolMetrics(stats: ToolConversationStats | undefined): MetricValue[] {
  if (!stats) {
    return [];
  }
  return [
    { name: "ToolRequestCount", unit: "Count", value: stats.requests },
    { name: "ToolRoundCount", unit: "Count", value: stats.rounds },
    { name: "ToolFailureCount", unit: "Count", value: stats.failures },
    ...(stats.usageIncomplete
      ? [{ name: "ToolUsageIncompleteCount", unit: "Count" as const, value: 1 }]
      : []),
  ];
}

function emitMetrics(input: {
  context: ChatTelemetryContext;
  metrics: MetricValue[];
  failureCategory?: string;
}): void {
  if (input.metrics.length === 0) {
    return;
  }

  const dimensions = input.failureCategory
    ? [["Service", "Environment", "Model", "FailureCategory"], ["Service", "Environment"]]
    : [["Service", "Environment", "Model"]];

  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: SERVICE_NAME,
        Dimensions: dimensions,
        Metrics: input.metrics.map((metric) => ({
          Name: metric.name,
          Unit: metric.unit,
        })),
      }],
    },
    Service: SERVICE_NAME,
    Environment: input.context.environment,
    Model: input.context.modelId,
    ...(input.failureCategory ? { FailureCategory: input.failureCategory } : {}),
    ...Object.fromEntries(input.metrics.map((metric) => [metric.name, metric.value])),
  }));
}

function logInfo(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({
    level: "info",
    service: SERVICE_NAME,
    event,
    ...fields,
  }));
}

function logError(event: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({
    level: "error",
    service: SERVICE_NAME,
    event,
    ...fields,
  }));
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
