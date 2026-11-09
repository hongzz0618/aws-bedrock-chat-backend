import type {
  ContentBlock,
  ConverseCommandInput,
  ConverseCommandOutput,
  ToolResultBlock,
} from "@aws-sdk/client-bedrock-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHandler } from "../src-ts/handler";
import { loadConfig } from "../src-ts/config";
import type { HttpEvent } from "../src-ts/types";
import * as tools from "../src-ts/tools";

const simulationNotice = "Simulated operational data — not live AWS observations.";
const event: HttpEvent = {
  rawPath: "/chat",
  requestContext: { http: { method: "POST" }, authorizer: { jwt: { claims: { sub: "user-a" } } } },
  body: JSON.stringify({ prompt: "Check my resources", session_id: "session-a", max_tokens: 4096 }),
};

function output(
  stopReason: ConverseCommandOutput["stopReason"],
  content: ContentBlock[],
  usage = { inputTokens: 50, outputTokens: 10, totalTokens: 60 } as ConverseCommandOutput["usage"],
): ConverseCommandOutput {
  return { $metadata: {}, stopReason, usage, output: { message: { role: "assistant", content } } };
}

function queue(id = "queue-1"): ContentBlock {
  return { toolUse: { toolUseId: id, name: "get_sqs_queue_status", input: { queue_alias: "orders-demo" } } };
}

function lambda(id = "lambda-1"): ContentBlock {
  return {
    toolUse: { toolUseId: id, name: "get_lambda_function_status", input: { function_alias: "chat-demo" } },
  };
}

function setup(responses: ConverseCommandOutput[], enabled = true, nowMs = () => 1_710_000_000_000, ragEnabled = false) {
  const converse = vi.fn(
    async (_request: ConverseCommandInput, _options?: { abortSignal?: AbortSignal }): Promise<ConverseCommandOutput> => {
      throw new Error("Unexpected Converse call");
    },
  );
  for (const response of responses) converse.mockResolvedValueOnce(response);
  const repository = {
    queryHistoryTurns: vi.fn(async () => [{ prompt: "Old question", response: "Old answer" }]),
    saveTurn: vi.fn(async () => undefined),
  };
  const handler = createHandler({
    config: loadConfig({ CHAT_TABLE: "mock-chat", TOOL_CALLING_ENABLED: enabled ? "true" : undefined, RAG_ENABLED: String(ragEnabled) }),
    bedrockClient: { converse },
    repository,
    generateTurnId: () => "turn-1",
    nowMs,
  });
  return { handler, converse, repository };
}

function sentResults(request: ConverseCommandInput): (ToolResultBlock | undefined)[] | undefined {
  return request.messages?.at(-1)?.content?.map((block) => block.toolResult);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Converse Tool Calling through the chat handler", () => {
  it.each([false, true])("matches tool results and saves the completed turn with RAG=%s", async (ragEnabled) => {
    const toolResponse = output("tool_use", [{ text: "Checking" }, queue()]);
    const final = output("end_turn", [{ text: "Queue has 12 messages." }, { text: "Two are in flight." }],
      { inputTokens: 90, outputTokens: 18, totalTokens: undefined });
    const { handler, converse, repository } = setup([toolResponse, final], true, undefined, ragEnabled);

    const response = await handler(event);
    const answer = simulationNotice + "\n\nQueue has 12 messages.\nTwo are in flight.";
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      response: answer,
      session_id: "session-a",
      timestamp: 1_710_000_000_000,
      stopReason: "end_turn",
      usage: { inputTokens: 140, outputTokens: 28, totalTokens: 168 },
    });

    const [first, second] = converse.mock.calls.map(([request]) => request);
    expect(first.toolConfig?.tools.map((tool) => tool.toolSpec?.name)).toEqual([
      "get_sqs_queue_status", "get_lambda_function_status",
    ]);
    expect(first.messages).toEqual([
      { role: "user", content: [{ text: "Old question" }] },
      { role: "assistant", content: [{ text: "Old answer" }] },
      { role: "user", content: [{ text: "Check my resources" }] },
    ]);
    expect(second.toolConfig).toEqual(first.toolConfig);
    expect(second.inferenceConfig?.maxTokens).toBe(4086);
    expect(second.messages?.slice(0, -1)).toEqual([...first.messages!, toolResponse.output?.message]);
    expect(second.messages?.at(-1)?.role).toBe("user");
    expect(sentResults(second)).toEqual([{
      toolUseId: "queue-1",
      content: [{ json: { source: "simulated", resourceAlias: "orders-demo", visibleMessages: 12, inFlightMessages: 2 } }],
    }]);

    expect(repository.queryHistoryTurns).toHaveBeenCalledOnce();
    expect(repository.queryHistoryTurns).toHaveBeenCalledWith("user-a", "session-a", 10);
    expect(repository.saveTurn).toHaveBeenCalledOnce();
    expect(repository.saveTurn).toHaveBeenCalledWith({
      user_id: "user-a",
      session_id: "session-a",
      sk: "SESSION#c2Vzc2lvbi1h#1710000000000#turn-1",
      timestamp: 1_710_000_000_000,
      expires_at: 1_710_604_800,
      prompt: "Check my resources",
      response: answer,
      model_id: loadConfig({}).modelId,
      input_tokens: 140,
      output_tokens: 28,
    });
  });

  it("handles two tools per batch for two rounds, with exact result IDs and no warm request state", async () => {
    const steps = [
      output("tool_use", [lambda(), queue()]),
      output("tool_use", [queue("queue-2"), lambda("lambda-2")]),
      output("end_turn", [{ text: "Checked both resources." }]),
    ];
    const { handler, converse, repository } = setup([...steps, ...steps]);
    expect((await handler(event)).statusCode).toBe(200);
    expect((await handler(event)).statusCode).toBe(200);
    expect(converse).toHaveBeenCalledTimes(6);
    expect(repository.saveTurn).toHaveBeenCalledTimes(2);
    const [initial, second, third, nextInitial] = converse.mock.calls.map(([request]) => request);
    expect(sentResults(second)?.map((result) => result?.toolUseId)).toEqual(["lambda-1", "queue-1"]);
    expect(sentResults(third)?.map((result) => result?.toolUseId)).toEqual(["queue-2", "lambda-2"]);
    expect(sentResults(second)?.[0]?.content?.[0]?.json).toMatchObject({
      source: "simulated", resourceAlias: "chat-demo", invocations: 42,
    });
    expect(nextInitial.messages).toEqual(initial.messages);
  });

  it("rejects a second batch that would exceed four cumulative tool requests", async () => {
    const prepare = tools.prepareToolRequest;
    const executed = vi.fn();
    vi.spyOn(tools, "prepareToolRequest").mockImplementation((name, input) => {
      const run = prepare(name, input);
      if (!run) return undefined;
      return () => {
        executed();
        return run();
      };
    });
    const { handler, converse, repository } = setup([
      output("tool_use", [queue("a"), lambda("b"), queue("c")]),
      output("tool_use", [lambda("d"), queue("e")]),
    ]);

    const response = await handler(event);
    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body)).toEqual({ error: "Chat request failed" });
    expect(converse).toHaveBeenCalledTimes(2);
    expect(sentResults(converse.mock.calls[1][0])?.map((result) => result?.toolUseId)).toEqual(["a", "b", "c"]);
    expect(executed).toHaveBeenCalledTimes(3);
    expect(repository.saveTurn).not.toHaveBeenCalled();
  });

  it("returns sanitized errors for unknown names, unknown aliases and extra arguments", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { handler, converse, repository } = setup([
      output("tool_use", [
        { toolUse: { toolUseId: "id-private-1", name: "__proto__", input: {} } },
        { toolUse: { toolUseId: "id-private-2", name: "get_sqs_queue_status", input: { queue_alias: "private-queue" } } },
        { toolUse: { toolUseId: "id-private-3", name: "get_lambda_function_status", input: { function_alias: "chat-demo", extra: true } } },
        queue(),
      ]),
      output("end_turn", [{ text: "Some data was unavailable." }]),
    ]);

    expect((await handler(event)).statusCode).toBe(200);
    const results = sentResults(converse.mock.calls[1][0])!;
    expect(results.slice(0, 3)).toEqual([1, 2, 3].map((index) => ({
      toolUseId: "id-private-" + index,
      status: "error",
      content: [{ text: "Simulated tool request failed." }],
    })));
    expect(results[3]?.status).toBeUndefined();
    expect(repository.saveTurn).toHaveBeenCalledOnce();
    const telemetry = JSON.stringify([...logs.mock.calls, ...errors.mock.calls]);
    expect(telemetry).not.toMatch(/id-private|private-queue|visibleMessages|__proto__/);
  });

  it.each([
    ["duplicate ID within a batch", output("tool_use", [queue(), lambda("queue-1")])],
    ["missing ID", output("tool_use", [queue(), { toolUse: { toolUseId: undefined, name: "get_sqs_queue_status", input: {} } }])],
    ["tool blocks with a final stop reason", output("end_turn", [{ text: "Incomplete" }, queue()])],
    ["tool stop without requests", output("tool_use", [{ text: "Incomplete" }])],
    ["unexpected stop reason", output("malformed_tool_use", [{ text: "Incomplete" }])],
    ["missing stop reason", output(undefined, [{ text: "Incomplete" }])],
    ["unsupported content block", output("end_turn", [{ text: "Incomplete" }, { $unknown: ["other", {}] }])],
    ["more than four requests", output("tool_use", [queue("a"), queue("b"), queue("c"), queue("d"), queue("e")])],
    ["oversized UTF-8 input later in a batch", output("tool_use", [
      queue(),
      { toolUse: { toolUseId: "large", name: "get_sqs_queue_status", input: { queue_alias: "é".repeat(512) } } },
    ])],
    ["oversized added transcript", output("tool_use", [{ text: "x".repeat(32 * 1024) }, queue()])],
  ])("rejects %s before executing fixtures or saving", async (_name, response) => {
    const execute = vi.fn(() => []);
    vi.spyOn(tools, "prepareToolRequest").mockReturnValue(execute);
    const { handler, converse, repository } = setup([response]);
    const result = await handler(event);
    expect(result.statusCode).toBe(502);
    expect(JSON.parse(result.body)).toEqual({ error: "Chat request failed" });
    expect(converse).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(repository.saveTurn).not.toHaveBeenCalled();
  });

  it.each([
    ["an ID reused in a later round", [output("tool_use", [queue()]), output("tool_use", [queue()])]],
    ["a third tool round", [
      output("tool_use", [queue()]), output("tool_use", [lambda()]), output("tool_use", [queue("third")]),
    ]],
    ["an oversized final answer including the prefix", [
      output("tool_use", [queue()]), output("end_turn", [{ text: "x".repeat(16 * 1024) }]),
    ]],
    ["a tool result with no remaining generation allowance", [
      output("tool_use", [queue()], { inputTokens: 100, outputTokens: 4096, totalTokens: 4196 }),
    ]],
  ])("stops on %s and saves no partial turn", async (_name, responses) => {
    const { handler, converse, repository } = setup(responses);
    expect((await handler(event)).statusCode).toBe(502);
    expect(converse).toHaveBeenCalledTimes(responses.length);
    expect(repository.saveTurn).not.toHaveBeenCalled();
  });

  it("sanitizes fixture exceptions and bounds serialized result size", async () => {
    const prepare = vi.spyOn(tools, "prepareToolRequest")
      .mockReturnValueOnce(() => { throw new Error("internal fixture detail"); })
      .mockReturnValueOnce(() => [{ text: "é".repeat(2048) }]);
    const { handler, converse, repository } = setup([
      output("tool_use", [queue()]), output("end_turn", [{ text: "Data unavailable." }]),
      output("tool_use", [queue()]),
    ]);

    expect((await handler(event)).statusCode).toBe(200);
    expect(sentResults(converse.mock.calls[1][0])).toEqual([{
      toolUseId: "queue-1", status: "error", content: [{ text: "Simulated tool request failed." }],
    }]);
    expect((await handler(event)).statusCode).toBe(502);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(converse).toHaveBeenCalledTimes(3);
    expect(repository.saveTurn).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing", undefined],
    ["negative", { inputTokens: 12, outputTokens: -1, totalTokens: 11 }],
    ["inconsistent", { inputTokens: 12, outputTokens: 1, totalTokens: 99 }],
    ["fractional", { inputTokens: 12, outputTokens: 1.5, totalTokens: 13.5 }],
  ])("fails closed when usage is %s and logs previously observed usage", async (_name, usage) => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const prepare = vi.spyOn(tools, "prepareToolRequest");
    const second = { ...output("tool_use", [lambda()]), usage };
    const { handler, converse, repository } = setup([output("tool_use", [queue()]), second]);

    expect((await handler(event)).statusCode).toBe(502);
    expect(converse).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledOnce();
    expect(repository.saveTurn).not.toHaveBeenCalled();
    expect(logs.mock.calls.map(([line]) => JSON.parse(line))).toContainEqual(expect.objectContaining({
      FailureCategory: "tool_usage", InputTokens: usage?.inputTokens === undefined ? 50 : 62,
      ToolUsageIncompleteCount: 1, TotalTokens: 60,
    }));
  });

  it.each([
    ["the orchestration budget", 60_000, 10_000],
    ["the Lambda reserve", 2_500, 500],
  ])("aborts the in-flight request at %s and cleans up its timer", async (_name, lambdaTime, expectedDelay) => {
    vi.useFakeTimers();
    const { handler, converse, repository } = setup([]);
    converse.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = handler(event, { getRemainingTimeInMillis: () => lambdaTime });
    await vi.advanceTimersByTimeAsync(expectedDelay - 1);
    const signal = converse.mock.calls[0][1]?.abortSignal;
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect((await pending).statusCode).toBe(502);
    expect(converse).toHaveBeenCalledOnce();
    expect(repository.saveTurn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not call Bedrock if Lambda is already inside its reserve", async () => {
    const { handler, converse, repository } = setup([]);
    expect((await handler(event, { getRemainingTimeInMillis: () => 2_000 })).statusCode).toBe(502);
    expect(converse).not.toHaveBeenCalled();
    expect(repository.saveTurn).not.toHaveBeenCalled();
  });

  it("gives the continuation only the time left in the original deadline", async () => {
    vi.useFakeTimers();
    const { handler, converse, repository } = setup([], true, Date.now);
    converse
      .mockImplementationOnce(() => new Promise((resolve) => {
        setTimeout(() => resolve(output("tool_use", [queue()])), 600);
      }))
      .mockImplementationOnce(() => new Promise(() => undefined));
    const pending = handler(event, { getRemainingTimeInMillis: () => 3000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(converse).toHaveBeenCalledTimes(2);
    const signal = converse.mock.calls[1][1]?.abortSignal;
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect((await pending).statusCode).toBe(502);
    expect(repository.saveTurn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the Bedrock throttle response after a tool round without saving the turn", async () => {
    const { handler, converse, repository } = setup([output("tool_use", [queue()])]);
    converse.mockRejectedValueOnce(Object.assign(new Error("AWS request detail"), { name: "ThrottlingException" }));
    const response = await handler(event);
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: "Chat service temporarily unavailable" });
    expect(converse).toHaveBeenCalledTimes(2);
    expect(repository.saveTurn).not.toHaveBeenCalled();
  });

  it("does not mark an enabled request that completes without using a tool", async () => {
    const { handler, converse, repository } = setup([output("max_tokens", [{ text: "Text only" }])]);
    const response = await handler(event);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ response: "Text only", stopReason: "max_tokens" });
    expect(converse).toHaveBeenCalledOnce();
    expect(repository.saveTurn).toHaveBeenCalledOnce();
  });

  it("keeps legacy text-only usage and rejects client-side enablement", async () => {
    expect(loadConfig({}).toolCallingEnabled).toBe(false);
    const legacy = { ...output(undefined, [{ text: "Legacy response" }]), usage: undefined };
    const { handler, converse, repository } = setup([legacy], false);
    const rejected = await handler({ ...event, body: '{"prompt":"hello","toolCallingEnabled":true}' });
    expect(rejected.statusCode).toBe(400);
    expect(converse).not.toHaveBeenCalled();

    const response = await handler(event);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ response: "Legacy response", usage: {} });
    expect(converse).toHaveBeenCalledOnce();
    expect(converse.mock.calls[0][0].toolConfig).toBeUndefined();
    expect(converse.mock.calls[0][1]).toBeUndefined();
    expect(repository.saveTurn).toHaveBeenCalledOnce();
  });
});
