import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { AwsBedrockConverseClient } from "../src-ts/bedrockClient";

afterEach(() => vi.restoreAllMocks());

it("passes the abort signal to the SDK and uses one attempt in tool mode", async () => {
  const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValueOnce({ $metadata: {} });
  const client = new AwsBedrockConverseClient("eu-west-1", true);
  const signal = new AbortController().signal;

  await client.converse({ modelId: "mock-model" }, { abortSignal: signal });

  expect(send).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith(expect.any(ConverseCommand), { abortSignal: signal });
  expect(await (send.mock.contexts[0] as BedrockRuntimeClient).config.maxAttempts()).toBe(1);
});
