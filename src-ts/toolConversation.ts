import type {
  ConverseCommandInput,
  ConverseCommandOutput,
  Message,
  ToolResultBlock,
} from "@aws-sdk/client-bedrock-runtime";
import type { BedrockConverseClient } from "./bedrockClient";
import { prepareToolRequest, simulatedToolConfig } from "./tools";

const LIMITS = {
  calls: 3,
  rounds: 2,
  requests: 4,
  timeMs: 10_000,
  lambdaReserveMs: 2_000,
  inputBytes: 1024,
  resultBytes: 4 * 1024,
  transcriptBytes: 32 * 1024,
  finalBytes: 16 * 1024,
  outputTokens: 4096,
} as const;
const SIMULATION_NOTICE = "Simulated operational data — not live AWS observations.";

export class ToolConversationError extends Error {
  constructor(readonly category: "tool_protocol" | "tool_usage" | "tool_limit" | "tool_deadline") {
    super(category);
    this.name = "ToolConversationError";
  }
}

type Usage = NonNullable<ConverseCommandOutput["usage"]>;

export interface ToolConversationStats {
  requests: number;
  rounds: number;
  failures: number;
  bedrockLatencyMs: number;
  usage?: Usage;
  usageIncomplete?: boolean;
}

export async function converseWithTools(input: {
  client: BedrockConverseClient;
  request: ConverseCommandInput;
  stats: ToolConversationStats;
  nowMs?: () => number;
  getRemainingTimeMs?: () => number;
}): Promise<{ text: string; usage: Usage; stopReason: ConverseCommandOutput["stopReason"] }> {
  const { client, request, stats } = input;
  const now = input.nowMs ?? (() => performance.now());
  const budgetMs = Math.min(
    LIMITS.timeMs,
    (input.getRemainingTimeMs?.() ?? Infinity) - LIMITS.lambdaReserveMs,
  );
  const deadline = now() + budgetMs;
  const remainingTime = () => {
    const remaining = deadline - now();
    if (!(remaining > 0)) {
      throw new ToolConversationError("tool_deadline");
    }
    return remaining;
  };

  const addedMessages: Message[] = [];
  const seenIds = new Set<string>();
  let usedSimulatedData = false;
  let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  for (let call = 1; call <= LIMITS.calls; call++) {
    const maxTokens = Math.min(
      request.inferenceConfig?.maxTokens ?? LIMITS.outputTokens,
      LIMITS.outputTokens - (usage.outputTokens ?? 0),
    );
    if (maxTokens <= 0) {
      throw new ToolConversationError("tool_limit");
    }

    const timeoutMs = remainingTime();
    const startedAt = now();
    let response: ConverseCommandOutput;
    stats.usageIncomplete = true;
    try {
      response = await converseBeforeDeadline(client, {
        ...request,
        messages: [...(request.messages ?? []), ...addedMessages],
        inferenceConfig: { ...request.inferenceConfig, maxTokens },
        toolConfig: simulatedToolConfig,
      }, timeoutMs);
    } finally {
      stats.bedrockLatencyMs += Math.max(0, now() - startedAt);
    }

    usage = accumulateUsage(stats, response.usage);
    remainingTime();
    if ((usage.outputTokens ?? 0) > LIMITS.outputTokens || (response.usage?.outputTokens ?? 0) > maxTokens) {
      throw new ToolConversationError("tool_limit");
    }

    const { message, requests, text } = inspectResponse(response, seenIds);
    if (requests.length === 0) {
      const finalText = usedSimulatedData ? SIMULATION_NOTICE + "\n\n" + text : text;
      checkSize(Buffer.byteLength(finalText), LIMITS.finalBytes);
      remainingTime();
      return { text: finalText, usage, stopReason: response.stopReason };
    }

    stats.requests += requests.length;
    if (call === LIMITS.calls || stats.rounds >= LIMITS.rounds ||
        stats.requests > LIMITS.requests || usage.outputTokens === LIMITS.outputTokens) {
      throw new ToolConversationError("tool_limit");
    }

    // Prepare the full batch before running any fixture.
    const batch = requests.map(({ toolUseId, name, input: args }) => {
      checkSize(jsonBytes(args), LIMITS.inputBytes);
      return { toolUseId, execute: prepareToolRequest(name, args) };
    });
    addedMessages.push(message);
    checkSize(jsonBytes(addedMessages), LIMITS.transcriptBytes);
    stats.rounds++;

    const results = batch.map(({ toolUseId, execute }) => {
      remainingTime();
      let content: ToolResultBlock["content"];
      try {
        content = execute?.();
      } catch {
        // Keep fixture exceptions out of the result and logs.
      }
      const result: ToolResultBlock = content
        ? { toolUseId, content }
        : { toolUseId, status: "error", content: [{ text: "Simulated tool request failed." }] };
      if (content) {
        usedSimulatedData = true;
      } else {
        stats.failures++;
      }
      checkSize(jsonBytes(result), LIMITS.resultBytes);
      remainingTime();
      return { toolResult: result };
    });

    addedMessages.push({ role: "user", content: results });
    checkSize(jsonBytes(addedMessages), LIMITS.transcriptBytes);
  }
  throw new ToolConversationError("tool_limit");
}

function inspectResponse(response: ConverseCommandOutput, seenIds: Set<string>) {
  const message = response.output?.message;
  if (message?.role !== "assistant" || !Array.isArray(message.content) || message.content.length === 0) {
    throw new ToolConversationError("tool_protocol");
  }

  const textBlocks: string[] = [];
  const requests = [];
  for (const block of message.content) {
    if (!block || typeof block !== "object" || Object.keys(block).length !== 1) {
      throw new ToolConversationError("tool_protocol");
    }
    if (typeof block.text === "string") {
      textBlocks.push(block.text);
      continue;
    }
    const tool = block.toolUse;
    if (response.stopReason !== "tool_use" || !tool || tool.type !== undefined ||
        typeof tool.toolUseId !== "string" || !/^[a-zA-Z0-9_.:-]{1,64}$/.test(tool.toolUseId) ||
        seenIds.has(tool.toolUseId) || typeof tool.name !== "string" ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) || tool.input === undefined) {
      throw new ToolConversationError("tool_protocol");
    }
    seenIds.add(tool.toolUseId);
    requests.push({ toolUseId: tool.toolUseId, name: tool.name, input: tool.input });
  }

  const text = textBlocks.join("\n").trim();
  const stop = response.stopReason;
  if (stop === "tool_use" ? requests.length === 0 :
    !text || (stop !== "end_turn" && stop !== "stop_sequence" && stop !== "max_tokens")) {
    throw new ToolConversationError("tool_protocol");
  }
  return { message, requests, text };
}

function accumulateUsage(stats: ToolConversationStats, reported: ConverseCommandOutput["usage"]): Usage {
  const inputTokens = validTokenCount(reported?.inputTokens);
  const outputTokens = validTokenCount(reported?.outputTokens);
  const sum = inputTokens === undefined || outputTokens === undefined
    ? undefined
    : validTokenCount(inputTokens + outputTokens);
  const reportedTotal = reported?.totalTokens;
  const totalTokens = reportedTotal === undefined ? sum : validTokenCount(reportedTotal);
  const consistent = sum !== undefined && totalTokens === sum;
  const previous = stats.usage;
  const knownUsage = {
    inputTokens: addKnown(previous?.inputTokens, inputTokens),
    outputTokens: addKnown(previous?.outputTokens, outputTokens),
    totalTokens: addKnown(previous?.totalTokens, consistent ? totalTokens : undefined),
  };
  stats.usage = {
    inputTokens: knownUsage.inputTokens ?? previous?.inputTokens,
    outputTokens: knownUsage.outputTokens ?? previous?.outputTokens,
    totalTokens: knownUsage.totalTokens ?? previous?.totalTokens,
  };
  if (!consistent || knownUsage.inputTokens === undefined ||
      knownUsage.outputTokens === undefined || knownUsage.totalTokens === undefined) {
    throw new ToolConversationError("tool_usage");
  }
  stats.usageIncomplete = false;
  return stats.usage;
}

function validTokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function addKnown(previous: number | undefined, current: number | undefined): number | undefined {
  return current === undefined ? undefined : validTokenCount((previous ?? 0) + current);
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    throw new ToolConversationError("tool_protocol");
  }
}

function checkSize(bytes: number, maxBytes: number): void {
  if (bytes > maxBytes) {
    throw new ToolConversationError("tool_limit");
  }
}

async function converseBeforeDeadline(
  client: BedrockConverseClient,
  request: ConverseCommandInput,
  timeoutMs: number,
): Promise<ConverseCommandOutput> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ToolConversationError("tool_deadline"));
      controller.abort();
    }, Math.ceil(timeoutMs));
  });
  try {
    return await Promise.race([client.converse(request, { abortSignal: controller.signal }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
