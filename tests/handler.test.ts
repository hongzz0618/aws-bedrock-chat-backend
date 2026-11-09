import type { ConverseCommandInput, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCachedChatDependenciesFactory, createHandler } from "../src-ts/handler";
import type { ChatRepository } from "../src-ts/chatRepository";
import type { ChatTurnItem, HttpEvent } from "../src-ts/types";
import { CHAT_REQUEST_LIMITS } from "../src-ts/validation";

const baseConfig = {
  chatTable: "chat-table",
  awsRegion: "us-east-1",
  environment: "test",
  modelId: "test-model",
  historyTurns: 10,
  maxContextChars: 24000,
  retentionDays: 7,
  maxTokens: 1024,
  temperature: 0.2,
};

function chatEvent(body: string | object, sub = "user-a"): HttpEvent {
  return {
    rawPath: "/chat",
    body: typeof body === "string" ? body : JSON.stringify(body),
    requestContext: {
      http: { method: "POST" },
      requestId: "request-1",
      authorizer: { jwt: { claims: { sub } } },
    },
  };
}

function unauthenticatedChatEvent(body: string | object): HttpEvent {
  return {
    rawPath: "/chat",
    body: typeof body === "string" ? body : JSON.stringify(body),
    requestContext: { http: { method: "POST" } },
  };
}

function namedAwsError(name: string, message: string, httpStatusCode?: number): Error {
  const error = new Error(message) as Error & {
    $metadata?: { httpStatusCode?: number };
  };
  error.name = name;
  error.$metadata = { httpStatusCode };
  return error;
}

function createMockRepository(history: ConverseCommandInput["messages"] = []): ChatRepository & {
  queryHistoryTurns: ReturnType<typeof vi.fn>;
  saveTurn: ReturnType<typeof vi.fn>;
} {
  const turns = [];
  for (let index = 0; index < history.length; index += 2) {
    const prompt = history[index]?.content?.[0]?.text;
    const response = history[index + 1]?.content?.[0]?.text;
    if (typeof prompt === "string" && typeof response === "string") {
      turns.push({ prompt, response });
    }
  }

  return {
    queryHistoryTurns: vi.fn(async () => turns),
    saveTurn: vi.fn(async () => undefined),
  };
}

function createMockBedrockClient(responseText = "mock response") {
  return {
    converse: vi.fn(async (): Promise<ConverseCommandOutput> => ({
      output: {
        message: {
          role: "assistant",
          content: [{ text: responseText }],
        },
      },
      $metadata: {},
    })),
  };
}

async function expectInvalidBeforeDownstream(
  body: object,
  sensitiveValues: string[] = [],
  flags: { ragEnabled?: boolean; toolCallingEnabled?: boolean } = {},
): Promise<void> {
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const repository = createMockRepository();
  const bedrockClient = createMockBedrockClient();

  const response = await createHandler({
    config: { ...baseConfig, ...flags },
    repository,
    bedrockClient,
  })(chatEvent(body));

  expect(response.statusCode).toBe(400);
  expect(JSON.parse(response.body)).toEqual({ error: "Invalid chat request" });
  expect(repository.queryHistoryTurns).not.toHaveBeenCalled();
  expect(repository.saveTurn).not.toHaveBeenCalled();
  expect(bedrockClient.converse).not.toHaveBeenCalled();
  const emitted = [
    ...consoleLog.mock.calls.map((call) => String(call[0])),
    ...consoleError.mock.calls.map((call) => String(call[0])),
  ].join("\n");
  for (const value of sensitiveValues) {
    expect(response.body).not.toContain(value);
    expect(emitted).not.toContain(value);
  }
  expect(consoleLog).not.toHaveBeenCalled();
  expect(consoleError).not.toHaveBeenCalled();
}

describe("handler", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns health response", async () => {
    const response = await createHandler()({
      rawPath: "/health",
      requestContext: { http: { method: "GET" } },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      status: "ok",
      service: "aws-bedrock-chat-backend",
    });
  });

  it("does not require authentication for GET /health", async () => {
    const response = await createHandler()({
      rawPath: "/health",
      requestContext: { http: { method: "GET" } },
    });

    expect(response.statusCode).toBe(200);
  });

  it("does not initialize default chat dependencies for GET /health", async () => {
    const createDefaultDependencies = vi.fn(() => {
      throw new Error("chat dependencies should not be created");
    });

    const response = await createHandler(
      {},
      createCachedChatDependenciesFactory(createDefaultDependencies),
    )({
      rawPath: "/health",
      requestContext: { http: { method: "GET" } },
    });

    expect(response.statusCode).toBe(200);
    expect(createDefaultDependencies).not.toHaveBeenCalled();
  });

  it("reuses cached default chat dependencies without caching request data", async () => {
    const savedItems: ChatTurnItem[] = [];
    const repository: ChatRepository = {
      async queryHistoryTurns(_userId, sessionId) {
        return [
          { prompt: `history prompt ${sessionId}`, response: `history response ${sessionId}` },
        ];
      },
      async saveTurn(item) {
        savedItems.push(item);
      },
    };
    const bedrockRequests: ConverseCommandInput[] = [];
    const bedrockClient = {
      async converse(input: ConverseCommandInput): Promise<ConverseCommandOutput> {
        bedrockRequests.push(input);
        return {
          output: {
            message: {
              role: "assistant",
              content: [{ text: `response ${bedrockRequests.length}` }],
            },
          },
          $metadata: {},
        };
      },
    };
    const createDefaultDependencies = vi.fn(() => ({
      config: baseConfig,
      repository,
      bedrockClient,
      generateTurnId: () => `turn-${savedItems.length + 1}`,
      nowMs: () => 1710000000000 + savedItems.length,
    }));
    const handler = createHandler(
      {},
      createCachedChatDependenciesFactory(createDefaultDependencies),
    );

    const firstResponse = await handler(chatEvent({
      prompt: "first prompt",
      session_id: "session-a",
    }));
    const secondResponse = await handler(chatEvent({
      prompt: "second prompt",
      session_id: "session-b",
    }));

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(createDefaultDependencies).toHaveBeenCalledOnce();
    expect(bedrockRequests).toHaveLength(2);
    expect(bedrockRequests[0]?.messages).toEqual([
      { role: "user", content: [{ text: "history prompt session-a" }] },
      { role: "assistant", content: [{ text: "history response session-a" }] },
      { role: "user", content: [{ text: "first prompt" }] },
    ]);
    expect(bedrockRequests[1]?.messages).toEqual([
      { role: "user", content: [{ text: "history prompt session-b" }] },
      { role: "assistant", content: [{ text: "history response session-b" }] },
      { role: "user", content: [{ text: "second prompt" }] },
    ]);
    expect(savedItems.map((item) => item.session_id)).toEqual(["session-a", "session-b"]);
    expect(savedItems.map((item) => item.prompt)).toEqual(["first prompt", "second prompt"]);
  });

  it("returns 404 for unknown routes", async () => {
    const response = await createHandler()({
      rawPath: "/unknown",
      requestContext: { http: { method: "GET" } },
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toEqual({ error: "Not Found" });
  });

  it("returns 401 for POST /chat when JWT identity is missing", async () => {
    const response = await createHandler({ config: baseConfig })(
      unauthenticatedChatEvent({ prompt: "hello" }),
    );

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 for POST /chat when JWT sub claim is malformed", async () => {
    const event = chatEvent({ prompt: "hello" });
    event.requestContext = {
      http: { method: "POST" },
      authorizer: { jwt: { claims: { sub: 123 } } },
    };

    const response = await createHandler({ config: baseConfig })(event);

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: "Unauthorized" });
  });

  it.each([null, "", " ", "chat", "RUNBOOK", " runbook ", 1, true, [], {}])(
    "rejects invalid mode %j before downstream calls", async (mode) => {
      await expectInvalidBeforeDownstream({ prompt: "hello", mode });
    },
  );

  it.each([
    [false, false], [false, true], [true, false], [true, true],
  ])("blocks runbook execution with RAG=%s and tools=%s", async (ragEnabled, toolCallingEnabled) => {
    for (const fields of [{}, { system_prompt: "" }, { system_prompt: null }, { history_turns: 0 }, { history_turns: null }]) {
      await expectInvalidBeforeDownstream(
        { prompt: "hello", mode: "runbook", ...fields }, [], { ragEnabled, toolCallingEnabled },
      );
    }
  });

  it("authenticates runbook requests before rejecting the mode", async () => {
    const repository = createMockRepository();
    const bedrockClient = createMockBedrockClient();
    const response = await createHandler({ config: { ...baseConfig, ragEnabled: true }, repository, bedrockClient })(
      unauthenticatedChatEvent({ prompt: "hello", mode: "runbook" }),
    );
    expect(response.statusCode).toBe(401);
    expect(repository.queryHistoryTurns).not.toHaveBeenCalled();
    expect(repository.saveTurn).not.toHaveBeenCalled();
    expect(bedrockClient.converse).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps user-scoped sessions with RAG=%s", async (ragEnabled) => {
    const repository = createMockRepository();
    const handler = createHandler({ config: { ...baseConfig, ragEnabled }, repository, bedrockClient: createMockBedrockClient() });
    for (const user of ["user-a", "user-b"]) {
      expect((await handler(chatEvent({ prompt: "hello", session_id: "shared" }, user))).statusCode).toBe(200);
      expect(repository.queryHistoryTurns).toHaveBeenLastCalledWith(user, "shared", baseConfig.historyTurns);
      expect(repository.saveTurn).toHaveBeenLastCalledWith(expect.objectContaining({ user_id: user, session_id: "shared" }));
    }
  });

  it("returns 400 for POST /chat with malformed JSON", async () => {
    const response = await createHandler({ config: baseConfig })(chatEvent("{"));

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: "Invalid chat request" });
  });

  it("returns 400 for POST /chat with a non-object JSON body", async () => {
    const response = await createHandler({ config: baseConfig })(chatEvent("[]"));

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: "Invalid chat request" });
  });

  it("rejects client-supplied user_id in the request body", async () => {
    await expectInvalidBeforeDownstream({
      prompt: "hello",
      user_id: "attacker-user",
    }, ["attacker-user"]);
  });

  it("rejects unknown top-level request fields before DynamoDB or Bedrock calls", async () => {
    await expectInvalidBeforeDownstream({
      prompt: "hello",
      unexpected_field: "sensitive unexpected value",
    }, ["sensitive unexpected value"]);
  });

  it("returns 400 for POST /chat with a missing prompt", async () => {
    const response = await createHandler({ config: baseConfig })(chatEvent({}));

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: "Invalid chat request" });
  });

  it("does not log chat failure metrics for invalid chat requests", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await createHandler({ config: baseConfig })(chatEvent({ prompt: "   " }));

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: "Invalid chat request" });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("returns 400 for POST /chat with a blank prompt", async () => {
    const response = await createHandler({ config: baseConfig })(chatEvent({ prompt: "   " }));

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: "Invalid chat request" });
  });

  it("returns 400 for POST /chat with an oversized prompt", async () => {
    const response = await createHandler({ config: baseConfig })(chatEvent({
      prompt: "x".repeat(8001),
    }));

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: "Invalid chat request" });
  });

  it("accepts session_id at the trimmed maximum length", async () => {
    const sessionId = "s".repeat(CHAT_REQUEST_LIMITS.sessionIdMaxLength);
    const repository = createMockRepository();
    const bedrockClient = createMockBedrockClient();

    const response = await createHandler({
      config: baseConfig,
      repository,
      bedrockClient,
      nowMs: () => 1710000000002,
    })(chatEvent({
      prompt: "hello",
      session_id: sessionId,
    }));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).session_id).toBe(sessionId);
    expect(repository.queryHistoryTurns).toHaveBeenCalledWith("user-a", sessionId, baseConfig.historyTurns);
    expect(repository.saveTurn).toHaveBeenCalledWith(expect.objectContaining({
      session_id: sessionId,
    }));
  });

  it("validates session_id length after trimming", async () => {
    const sessionId = "s".repeat(CHAT_REQUEST_LIMITS.sessionIdMaxLength);
    const repository = createMockRepository();
    const bedrockClient = createMockBedrockClient();

    const response = await createHandler({
      config: baseConfig,
      repository,
      bedrockClient,
      nowMs: () => 1710000000003,
    })(chatEvent({
      prompt: "hello",
      session_id: `  ${sessionId}  `,
    }));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).session_id).toBe(sessionId);
    expect(repository.queryHistoryTurns).toHaveBeenCalledWith("user-a", sessionId, baseConfig.historyTurns);
  });

  it("rejects oversized session_id before DynamoDB or Bedrock calls", async () => {
    await expectInvalidBeforeDownstream({
      prompt: "hello",
      session_id: "s".repeat(CHAT_REQUEST_LIMITS.sessionIdMaxLength + 1),
    });
  });

  it("returns 400 for POST /chat with invalid history_turns", async () => {
    const response = await createHandler({ config: baseConfig })(chatEvent({
      prompt: "hello",
      history_turns: 21,
    }));

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: "Invalid chat request" });
  });

  it("returns 400 for POST /chat with invalid max_tokens", async () => {
    const response = await createHandler({ config: baseConfig })(chatEvent({
      prompt: "hello",
      max_tokens: 0,
    }));

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: "Invalid chat request" });
  });

  it("returns 400 for POST /chat with invalid temperature or top_p", async () => {
    for (const body of [
      { prompt: "hello", temperature: 1.1 },
      { prompt: "hello", top_p: "0.9" },
    ]) {
      const response = await createHandler({ config: baseConfig })(chatEvent(body));

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: "Invalid chat request" });
    }
  });

  it("rejects requests with both temperature and top_p before DynamoDB or Bedrock calls", async () => {
    await expectInvalidBeforeDownstream({
      prompt: "hello",
      temperature: 0,
      top_p: 1,
    });
  });

  it("returns 400 for invalid field types and decimal integer values", async () => {
    for (const body of [
      { prompt: 123 },
      { prompt: "hello", session_id: null },
      { prompt: "hello", system_prompt: false },
      { prompt: "hello", history_turns: 1.5 },
      { prompt: "hello", history_turns: null },
      { prompt: "hello", max_tokens: "10" },
      { prompt: "hello", temperature: null },
      { prompt: "hello", top_p: {} },
    ]) {
      const response = await createHandler({ config: baseConfig })(chatEvent(body));

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: "Invalid chat request" });
    }
  });

  it("continues to generate a session ID when session_id is blank", async () => {
    const repository = createMockRepository();
    const bedrockClient = createMockBedrockClient();

    const response = await createHandler({
      config: baseConfig,
      repository,
      bedrockClient,
      generateSessionId: () => "generated-session",
      nowMs: () => 1710000000004,
    })(chatEvent({
      prompt: "hello",
      session_id: "   ",
    }));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).session_id).toBe("generated-session");
    expect(repository.queryHistoryTurns).toHaveBeenCalledWith(
      "user-a",
      "generated-session",
      baseConfig.historyTurns,
    );
  });

  it("rejects non-string session_id before DynamoDB or Bedrock calls", async () => {
    await expectInvalidBeforeDownstream({
      prompt: "hello",
      session_id: 123,
    });
  });

  it("accepts system_prompt at the trimmed maximum length and sends it to Bedrock", async () => {
    const systemPrompt = "s".repeat(CHAT_REQUEST_LIMITS.systemPromptMaxLength);
    const repository = createMockRepository();
    const bedrockClient = createMockBedrockClient();

    const response = await createHandler({
      config: baseConfig,
      repository,
      bedrockClient,
      generateSessionId: () => "system-session",
      nowMs: () => 1710000000005,
    })(chatEvent({
      prompt: "hello",
      system_prompt: systemPrompt,
    }));

    expect(response.statusCode).toBe(200);
    expect(bedrockClient.converse).toHaveBeenCalledWith(expect.objectContaining({
      system: [{ text: systemPrompt }],
    }));
  });

  it("validates system_prompt length after trimming", async () => {
    const systemPrompt = "s".repeat(CHAT_REQUEST_LIMITS.systemPromptMaxLength);
    const repository = createMockRepository();
    const bedrockClient = createMockBedrockClient();

    const response = await createHandler({
      config: baseConfig,
      repository,
      bedrockClient,
      generateSessionId: () => "system-session",
      nowMs: () => 1710000000006,
    })(chatEvent({
      prompt: "hello",
      system_prompt: `  ${systemPrompt}  `,
    }));

    expect(response.statusCode).toBe(200);
    expect(bedrockClient.converse).toHaveBeenCalledWith(expect.objectContaining({
      system: [{ text: systemPrompt }],
    }));
  });

  it("does not add a Bedrock system prompt when system_prompt is blank", async () => {
    const repository = createMockRepository();
    const bedrockClient = createMockBedrockClient();

    const response = await createHandler({
      config: baseConfig,
      repository,
      bedrockClient,
      generateSessionId: () => "system-session",
      nowMs: () => 1710000000007,
    })(chatEvent({
      prompt: "hello",
      system_prompt: "   ",
    }));

    expect(response.statusCode).toBe(200);
    expect(bedrockClient.converse).toHaveBeenCalledWith(expect.not.objectContaining({
      system: expect.anything(),
    }));
  });

  it("rejects oversized system_prompt before DynamoDB or Bedrock calls", async () => {
    await expectInvalidBeforeDownstream({
      prompt: "hello",
      system_prompt: "s".repeat(CHAT_REQUEST_LIMITS.systemPromptMaxLength + 1),
    });
  });

  it("rejects non-string system_prompt before DynamoDB or Bedrock calls", async () => {
    await expectInvalidBeforeDownstream({
      prompt: "hello",
      system_prompt: 123,
    });
  });

  it("returns 400 when request-level model_id is supplied", async () => {
    await expectInvalidBeforeDownstream({
      prompt: "hello",
      model_id: "override-model",
    }, ["override-model"]);
  });

  it("returns 500 for POST /chat when CHAT_TABLE is missing", async () => {
    const response = await createHandler({
      config: { ...baseConfig, chatTable: undefined },
    })(chatEvent({ prompt: "hello" }));

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ error: "Chat request failed" });
  });

  it.each([false, true])("handles regular chat success with RAG=%s", async (ragEnabled) => {
    const savedItems: ChatTurnItem[] = [];
    const repository: ChatRepository = {
      async queryHistoryTurns() {
        return [
          { prompt: "previous prompt", response: "previous response" },
        ];
      },
      async saveTurn(item) {
        savedItems.push(item);
      },
    };
    const bedrockRequests: ConverseCommandInput[] = [];
    const bedrockClient = {
      async converse(input: ConverseCommandInput): Promise<ConverseCommandOutput> {
        bedrockRequests.push(input);
        return {
          output: {
            message: {
              role: "assistant",
              content: [{ text: "mock response" }],
            },
          },
          usage: {
            inputTokens: 12,
            outputTokens: 4,
            totalTokens: 16,
          },
          stopReason: "end_turn",
          $metadata: {},
        };
      },
    };
    const event = chatEvent({
      prompt: "hello",
      session_id: "session-1",
      system_prompt: "be brief",
      history_turns: 2,
      max_tokens: 99,
      temperature: 0.3,
    });

    const response = await createHandler({
      config: { ...baseConfig, ragEnabled },
      repository,
      bedrockClient,
      nowMs: () => 1710000000000,
      generateSessionId: () => "generated-session",
      generateTurnId: () => "turn-1",
    })(event);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      session_id: "session-1",
      timestamp: 1710000000000,
      response: "mock response",
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        totalTokens: 16,
      },
      stopReason: "end_turn",
    });
    expect(bedrockRequests).toHaveLength(1);
    expect(bedrockRequests[0]).toMatchObject({
      modelId: "test-model",
      system: [{ text: "be brief" }],
      inferenceConfig: {
        maxTokens: 99,
        temperature: 0.3,
      },
    });
    expect(bedrockRequests[0]?.inferenceConfig).not.toHaveProperty("topP");
    expect(bedrockRequests[0]?.messages).toEqual([
      { role: "user", content: [{ text: "previous prompt" }] },
      { role: "assistant", content: [{ text: "previous response" }] },
      { role: "user", content: [{ text: "hello" }] },
    ]);
    expect(savedItems).toEqual([
      {
        user_id: "user-a",
        session_id: "session-1",
        sk: "SESSION#c2Vzc2lvbi0x#1710000000000#turn-1",
        timestamp: 1710000000000,
        prompt: "hello",
        response: "mock response",
        model_id: "test-model",
        expires_at: 1710604800,
        input_tokens: 12,
        output_tokens: 4,
      },
    ]);
  });

  it("uses default temperature and omits topP when sampling parameters are omitted", async () => {
    const repository = createMockRepository();
    const bedrockClient = createMockBedrockClient();

    const response = await createHandler({
      config: baseConfig,
      repository,
      bedrockClient,
      generateSessionId: () => "default-sampling-session",
      nowMs: () => 1710000000001,
    })(chatEvent({
      prompt: "hello",
    }));

    expect(response.statusCode).toBe(200);
    expect(bedrockClient.converse).toHaveBeenCalledWith(expect.objectContaining({
      inferenceConfig: {
        maxTokens: baseConfig.maxTokens,
        temperature: baseConfig.temperature,
      },
    }));
    expect(bedrockClient.converse.mock.calls[0]?.[0].inferenceConfig).not.toHaveProperty("topP");
  });

  it("sends only temperature when temperature is supplied at a boundary", async () => {
    const repository = createMockRepository();
    const bedrockClient = createMockBedrockClient();

    const response = await createHandler({
      config: baseConfig,
      repository,
      bedrockClient,
      generateSessionId: () => "temperature-session",
      nowMs: () => 1710000000001,
    })(chatEvent({
      prompt: "hello",
      temperature: 0,
    }));

    expect(response.statusCode).toBe(200);
    expect(bedrockClient.converse).toHaveBeenCalledWith(expect.objectContaining({
      inferenceConfig: {
        maxTokens: baseConfig.maxTokens,
        temperature: 0,
      },
    }));
    expect(bedrockClient.converse.mock.calls[0]?.[0].inferenceConfig).not.toHaveProperty("topP");
  });

  it("sends only topP when top_p is supplied at a boundary", async () => {
    const repository = createMockRepository();
    const bedrockClient = createMockBedrockClient();

    const response = await createHandler({
      config: baseConfig,
      repository,
      bedrockClient,
      generateSessionId: () => "top-p-session",
      nowMs: () => 1710000000001,
    })(chatEvent({
      prompt: "hello",
      top_p: 1,
    }));

    expect(response.statusCode).toBe(200);
    expect(bedrockClient.converse).toHaveBeenCalledWith(expect.objectContaining({
      inferenceConfig: {
        maxTokens: baseConfig.maxTokens,
        topP: 1,
      },
    }));
    expect(bedrockClient.converse.mock.calls[0]?.[0].inferenceConfig).not.toHaveProperty("temperature");
  });

  it("accepts documented non-sampling parameter boundaries", async () => {
    const historyLimits: number[] = [];
    const repository: ChatRepository = {
      async queryHistoryTurns(_userId, _sessionId, limit) {
        historyLimits.push(limit);
        return [];
      },
      async saveTurn() {
        return undefined;
      },
    };
    const bedrockRequests: ConverseCommandInput[] = [];
    const bedrockClient = {
      async converse(input: ConverseCommandInput): Promise<ConverseCommandOutput> {
        bedrockRequests.push(input);
        return {
          output: {
            message: {
              role: "assistant",
              content: [{ text: "boundary response" }],
            },
          },
          $metadata: {},
        };
      },
    };

    const handler = createHandler({
      config: baseConfig,
      repository,
      bedrockClient,
      generateSessionId: () => "boundary-session",
      nowMs: () => 1710000000001,
    });

    const lowerResponse = await handler(chatEvent({
      prompt: "hello",
      history_turns: 0,
      max_tokens: 1,
      temperature: 0,
    }));
    const upperResponse = await handler(chatEvent({
      prompt: "x".repeat(8000),
      history_turns: 20,
      max_tokens: 4096,
      top_p: 1,
    }));

    expect(lowerResponse.statusCode).toBe(200);
    expect(upperResponse.statusCode).toBe(200);
    expect(historyLimits).toEqual([0, 20]);
    expect(bedrockRequests[0]?.inferenceConfig).toEqual({
      maxTokens: 1,
      temperature: 0,
    });
    expect(bedrockRequests[1]?.inferenceConfig).toEqual({
      maxTokens: 4096,
      topP: 1,
    });
  });

  it("returns 503 without raw AWS details when Bedrock is throttled", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const repository: ChatRepository = {
      async queryHistoryTurns() {
        return [];
      },
      async saveTurn() {
        throw new Error("saveTurn should not be called");
      },
    };
    const bedrockClient = {
      async converse(): Promise<ConverseCommandOutput> {
        throw namedAwsError("ThrottlingException", "rate limit: request abc", 429);
      },
    };

    const response = await createHandler({
      config: baseConfig,
      repository,
      bedrockClient,
    })(chatEvent({ prompt: "hello" }));

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({
      error: "Chat service temporarily unavailable",
    });
    expect(response.body).not.toContain("request abc");
    expect(consoleError).toHaveBeenCalledOnce();
    const logEntry = JSON.parse(String(consoleError.mock.calls[0]?.[0]));
    expect(logEntry).toMatchObject({
      level: "error",
      event: "chat_request_failed",
      failureCategory: "bedrock_retryable",
      errorName: "ThrottlingException",
      httpStatusCode: 429,
    });
    expect(logEntry).not.toHaveProperty("errorMessage");
  });

  it("returns a generic error when Bedrock access is denied", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const repository: ChatRepository = {
      async queryHistoryTurns() {
        return [];
      },
      async saveTurn() {
        throw new Error("saveTurn should not be called");
      },
    };
    const bedrockClient = {
      async converse(): Promise<ConverseCommandOutput> {
        throw namedAwsError("AccessDeniedException", "internal account detail", 403);
      },
    };

    const response = await createHandler({
      config: baseConfig,
      repository,
      bedrockClient,
    })(chatEvent({ prompt: "hello" }));

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ error: "Chat request failed" });
    expect(response.body).not.toContain("AccessDeniedException");
    expect(response.body).not.toContain("internal account detail");
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it("returns a generic upstream error when Bedrock rejects the service request", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const repository: ChatRepository = {
      async queryHistoryTurns() {
        return [];
      },
      async saveTurn() {
        throw new Error("saveTurn should not be called");
      },
    };
    const bedrockClient = {
      async converse(): Promise<ConverseCommandOutput> {
        throw namedAwsError("ValidationException", "raw model validation detail", 400);
      },
    };

    const response = await createHandler({
      config: baseConfig,
      repository,
      bedrockClient,
    })(chatEvent({ prompt: "hello" }));

    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body)).toEqual({ error: "Chat request failed" });
    expect(response.body).not.toContain("raw model validation detail");
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it("returns a generic error when persistence fails after Bedrock succeeds", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const repository: ChatRepository = {
      async queryHistoryTurns() {
        return [];
      },
      async saveTurn() {
        throw new Error("DynamoDB table detail");
      },
    };
    const bedrockClient = {
      async converse(): Promise<ConverseCommandOutput> {
        return {
          output: {
            message: {
              role: "assistant",
              content: [{ text: "mock response" }],
            },
          },
          $metadata: {},
        };
      },
    };

    const response = await createHandler({
      config: baseConfig,
      repository,
      bedrockClient,
    })(chatEvent({ prompt: "hello" }));

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ error: "Chat request failed" });
    expect(response.body).not.toContain("DynamoDB table detail");
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it("does not save an empty Bedrock text response as a successful turn", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const repository = createMockRepository();
    const bedrockClient = createMockBedrockClient("   ");

    const response = await createHandler({
      config: baseConfig,
      repository,
      bedrockClient,
    })(chatEvent({ prompt: "hello" }));

    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body)).toEqual({ error: "Chat request failed" });
    expect(repository.saveTurn).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it("does not save Bedrock responses that contain only non-text content blocks", async () => {
    const repository = createMockRepository();
    const bedrockClient = {
      converse: vi.fn(async (): Promise<ConverseCommandOutput> => ({
        output: {
          message: {
            role: "assistant",
            content: [{ json: { value: "not text" } }],
          },
        },
        $metadata: {},
      })),
    };

    const response = await createHandler({
      config: baseConfig,
      repository,
      bedrockClient,
    })(chatEvent({ prompt: "hello" }));

    expect(response.statusCode).toBe(502);
    expect(repository.saveTurn).not.toHaveBeenCalled();
  });

  it("emits context truncation metrics without splitting history or dropping system prompt", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const repository: ChatRepository = {
      async queryHistoryTurns() {
        return [
          { prompt: "old prompt xxxxx", response: "old response xxxxx" },
          { prompt: "new prompt", response: "new response" },
        ];
      },
      async saveTurn() {
        return undefined;
      },
    };
    const bedrockRequests: ConverseCommandInput[] = [];
    const bedrockClient = {
      async converse(input: ConverseCommandInput): Promise<ConverseCommandOutput> {
        bedrockRequests.push(input);
        return {
          output: { message: { role: "assistant", content: [{ text: "ok" }] } },
          $metadata: {},
        };
      },
    };

    const response = await createHandler({
      config: { ...baseConfig, maxContextChars: 30 },
      repository,
      bedrockClient,
      nowMs: () => 1710000000000,
    })(chatEvent({
      prompt: "current",
      system_prompt: "system stays separate",
    }));

    expect(response.statusCode).toBe(200);
    expect(bedrockRequests[0]?.system).toEqual([{ text: "system stays separate" }]);
    expect(bedrockRequests[0]?.messages).toEqual([
      { role: "user", content: [{ text: "new prompt" }] },
      { role: "assistant", content: [{ text: "new response" }] },
      { role: "user", content: [{ text: "current" }] },
    ]);
    const logs = consoleLog.mock.calls.map((call) => String(call[0]));
    expect(logs.some((line) => line.includes("ContextTruncatedCount"))).toBe(true);
  });

  it("keeps sensitive request content out of logs and metric dimensions", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const repository = createMockRepository();
    const bedrockClient = createMockBedrockClient("safe response");

    await createHandler({
      config: baseConfig,
      repository,
      bedrockClient,
    })(chatEvent({
      prompt: "secret prompt text",
      session_id: "secret-session",
      system_prompt: "secret system text",
    }, "secret-user"));

    const emitted = [
      ...consoleLog.mock.calls.map((call) => String(call[0])),
      ...consoleError.mock.calls.map((call) => String(call[0])),
    ].join("\n");

    expect(emitted).not.toContain("secret prompt text");
    expect(emitted).not.toContain("secret system text");
    expect(emitted).not.toContain("secret-user");
    expect(emitted).not.toContain("secret-session");
    expect(emitted).not.toContain("Authorization");

    const metricEntries = consoleLog.mock.calls
      .map((call) => JSON.parse(String(call[0])) as { _aws?: { CloudWatchMetrics?: Array<{ Dimensions: string[][] }> } })
      .filter((entry) => entry._aws);
    for (const entry of metricEntries) {
      const dimensions = entry._aws?.CloudWatchMetrics?.flatMap((metric) => metric.Dimensions) ?? [];
      expect(dimensions.flat()).not.toContain("user_id");
      expect(dimensions.flat()).not.toContain("session_id");
      expect(dimensions.flat()).not.toContain("requestId");
    }
  });
});
