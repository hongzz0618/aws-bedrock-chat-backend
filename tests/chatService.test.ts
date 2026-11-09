import { describe, expect, it } from "vitest";
import { buildBoundedContextMessages } from "../src-ts/chatService";
import { loadConfig } from "../src-ts/config";
import { InvalidChatRequestError, parseJsonBody } from "../src-ts/validation";

function messageTexts(result: ReturnType<typeof buildBoundedContextMessages>): string[] {
  return result.messages.map((message) => message.content?.[0]?.text ?? "");
}

describe("buildBoundedContextMessages", () => {
  it("keeps all history when it is within the character budget", () => {
    const result = buildBoundedContextMessages([
      { prompt: "old user", response: "old assistant" },
      { prompt: "new user", response: "new assistant" },
    ], "current prompt", 1000);

    expect(result.truncated).toBe(false);
    expect(messageTexts(result)).toEqual([
      "old user",
      "old assistant",
      "new user",
      "new assistant",
      "current prompt",
    ]);
  });

  it("removes the oldest complete turn when history exceeds the budget", () => {
    const result = buildBoundedContextMessages([
      { prompt: "old user xxxx", response: "old assistant xxxx" },
      { prompt: "new user", response: "new assistant" },
    ], "current", 31);

    expect(result.truncated).toBe(true);
    expect(messageTexts(result)).toEqual([
      "new user",
      "new assistant",
      "current",
    ]);
  });

  it("does not split a user/assistant turn", () => {
    const result = buildBoundedContextMessages([
      { prompt: "old user", response: "old assistant" },
      { prompt: "recent user", response: "recent assistant" },
    ], "current", 20);

    expect(result.truncated).toBe(true);
    expect(messageTexts(result)).toEqual(["current"]);
  });

  it("keeps a contiguous newest suffix and does not keep older turns after a newer turn is removed", () => {
    const result = buildBoundedContextMessages([
      { prompt: "tiny", response: "old" },
      { prompt: "recent prompt is too large", response: "recent response is too large" },
    ], "current", 20);

    expect(result.truncated).toBe(true);
    expect(messageTexts(result)).toEqual(["current"]);
  });

  it("keeps a complete turn when the budget boundary is exactly met", () => {
    const result = buildBoundedContextMessages([
      { prompt: "abc", response: "def" },
    ], "current", 13);

    expect(result.truncated).toBe(false);
    expect(messageTexts(result)).toEqual(["abc", "def", "current"]);
  });

  it("always keeps the current prompt even when it exceeds the budget", () => {
    const result = buildBoundedContextMessages([
      { prompt: "old user", response: "old assistant" },
    ], "current prompt that is longer than the configured budget", 5);

    expect(result.truncated).toBe(true);
    expect(messageTexts(result)).toEqual([
      "current prompt that is longer than the configured budget",
    ]);
  });

  it("keeps zero-history behavior as only the current prompt", () => {
    const result = buildBoundedContextMessages([], "current", 100);

    expect(result.truncated).toBe(false);
    expect(messageTexts(result)).toEqual(["current"]);
  });
});

describe("runbook request configuration and validation", () => {
  it.each([undefined, "", "false", "TRUE", " true ", "1"])("defaults RAG to false for %s", (value) => {
    expect(loadConfig({ RAG_ENABLED: value }).ragEnabled).toBe(false);
  });

  it("enables RAG only for exact true", () => {
    expect(loadConfig({ RAG_ENABLED: "true" }).ragEnabled).toBe(true);
  });

  it("parses a valid runbook shape before the execution guard", () => {
    const body = { prompt: "SQS backlog", mode: "runbook" };
    expect(parseJsonBody({ body: JSON.stringify(body) })).toEqual(body);
  });

  it.each([
    { system_prompt: "" }, { system_prompt: null }, { system_prompt: "brief" },
    { history_turns: 0 }, { history_turns: null }, { history_turns: "" },
    { system_prompt: "", history_turns: 0 },
  ])("rejects forbidden runbook fields %j before the execution guard", (fields) => {
    expect(() => parseJsonBody({ body: JSON.stringify({ prompt: "hello", mode: "runbook", ...fields }) }))
      .toThrow(InvalidChatRequestError);
  });
});

describe("loadConfig retention and context settings", () => {
  it("loads bounded context and retention defaults", () => {
    expect(loadConfig({}).maxContextChars).toBe(24000);
    expect(loadConfig({}).retentionDays).toBe(7);
  });

  it("uses eu-west-1 when no AWS Region environment variables are provided", () => {
    expect(loadConfig({}).awsRegion).toBe("eu-west-1");
  });

  it("prefers AWS_REGION over AWS_DEFAULT_REGION", () => {
    expect(loadConfig({
      AWS_REGION: "eu-central-1",
      AWS_DEFAULT_REGION: "eu-west-1",
    }).awsRegion).toBe("eu-central-1");
  });

  it("uses AWS_DEFAULT_REGION when AWS_REGION is not provided", () => {
    expect(loadConfig({ AWS_DEFAULT_REGION: "eu-west-3" }).awsRegion).toBe("eu-west-3");
  });

  it("fails fast for invalid retention configuration", () => {
    expect(() => loadConfig({ CHAT_RETENTION_DAYS: "0" })).toThrow(
      "Invalid integer config value",
    );
    expect(() => loadConfig({ CHAT_RETENTION_DAYS: "366" })).toThrow(
      "Invalid integer config value",
    );
    expect(() => loadConfig({ CHAT_RETENTION_DAYS: "1.5" })).toThrow(
      "Invalid integer config value",
    );
  });

  it("fails fast for invalid context budget configuration", () => {
    expect(() => loadConfig({ MAX_CONTEXT_CHARS: "0" })).toThrow(
      "Invalid integer config value",
    );
    expect(() => loadConfig({ MAX_CONTEXT_CHARS: "100.5" })).toThrow(
      "Invalid integer config value",
    );
  });

  it("fails fast for invalid numeric generation settings", () => {
    expect(() => loadConfig({ TEMPERATURE: "1.1" })).toThrow(
      "Invalid numeric config value",
    );
  });
});
