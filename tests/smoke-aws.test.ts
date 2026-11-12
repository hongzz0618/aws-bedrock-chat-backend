import { describe, expect, it, vi } from "vitest";
import { runSmoke } from "../scripts/smoke_aws.mjs";
import { RUNBOOK_ABSTENTION } from "../src-ts/runbookContext";

const env = {
  AWS_SMOKE_URL: "https://sample.execute-api.eu-west-1.amazonaws.com",
  AWS_SMOKE_JWT_A: "fake.payload.signature",
};

describe("AWS validation smoke script", () => {
  it.each(["baseline", "rag", "tools"])("previews %s without credentials or HTTP requests", async (profile) => {
    const request = vi.fn();
    const report = vi.fn();
    await runSmoke(profile, { env: {}, request, report });
    expect(request).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalled();
  });

  it("checks supported and repeated unsupported RAG responses without reporting their contents", async () => {
    const request = vi.fn(async (_url, options) => {
      const payload = JSON.parse(options.body);
      expect(payload.mode).toBe("runbook");
      expect(options.headers.Authorization).toBe(`Bearer ${env.AWS_SMOKE_JWT_A}`);
      expect(options.redirect).toBe("error");
      const supported = payload.prompt.startsWith("What does");
      return Response.json({
        session_id: payload.session_id,
        response: supported ? "synthetic model output" : RUNBOOK_ABSTENTION,
        usage: supported ? { inputTokens: 100 } : {},
        sources: supported ? [{ documentId: "sqs-backlog", chunkId: "sqs-backlog.metrics" }] : [],
      }, { headers: { "apigw-requestid": "example-id" } });
    });
    const report = vi.fn();
    await runSmoke("rag", { live: true, env, request, report, wait: vi.fn() });
    expect(request).toHaveBeenCalledTimes(3);
    expect(report.mock.calls.flat()).toEqual([
      "PASS rag-supported HTTP 200 requestId=example-id",
      "PASS rag-unsupported HTTP 200 requestId=example-id",
      "PASS rag-unsupported-repeat HTTP 200 requestId=example-id",
    ]);
  });

  it("rejects a different host before sending a credential", async () => {
    const request = vi.fn();
    await expect(runSmoke("rag", {
      live: true, env: { ...env, AWS_SMOKE_URL: "https://example.org" }, request,
    })).rejects.toThrow("AWS_SMOKE_URL");
    expect(request).not.toHaveBeenCalled();
  });

  it("stops on a throttled response without retrying or reporting its body", async () => {
    const request = vi.fn(async () => new Response("private error payload", { status: 429 }));
    await expect(runSmoke("rag", { live: true, env, request })).rejects.toThrow(/^FAIL rag-supported HTTP 429 /);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
