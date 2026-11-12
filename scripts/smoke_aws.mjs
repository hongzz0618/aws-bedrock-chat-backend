import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const abstention = "The available Runbooks do not contain sufficient evidence to answer this question.";
const simulationNotice = "Simulated operational data — not live AWS observations.";
const invalidRequest = (body) => body?.error === "Invalid chat request";
const exactAnswer = (answer) => (body) => body.response.trim() === answer;

function chat(label, sessionId, prompt, { token = "A", mode, check, tokens = 128 } = {}) {
  return {
    label,
    path: "/chat",
    token,
    expectedStatus: 200,
    payload: { session_id: sessionId, prompt, mode, temperature: 0, max_tokens: tokens },
    check: (body) => body?.session_id === sessionId &&
      typeof body.response === "string" && body.response.trim() !== "" &&
      (mode === "runbook" || !("sources" in body)) && check(body),
  };
}

function makeProbes(profile) {
  const runId = randomUUID();
  const session = `readiness-${runId}`;
  if (profile === "baseline") {
    const marker = `DEMO-${runId.slice(0, 8)}`;
    const recall = "Return the earlier DEMO marker from this conversation exactly. If there was no earlier marker, reply only UNKNOWN.";
    return [
      { label: "public-health", path: "/health", expectedStatus: 200,
        check: (body) => body?.status === "ok" && body.service === "aws-bedrock-chat-backend" },
      { label: "missing-jwt", path: "/chat", expectedStatus: 401, payload: { prompt: "Say hello." } },
      { label: "invalid-jwt", path: "/chat", token: "invalid", expectedStatus: 401, payload: { prompt: "Say hello." } },
      { label: "invalid-sampling", path: "/chat", token: "A", expectedStatus: 400,
        payload: { prompt: "Say hello.", temperature: 0, top_p: 0.5 }, check: invalidRequest },
      { label: "rag-disabled", path: "/chat", token: "A", expectedStatus: 400,
        payload: { mode: "runbook", prompt: "How do I investigate Lambda throttling?" }, check: invalidRequest },
      chat("chat-seed", session, `Remember this marker for a follow-up. Reply only with ${marker}`, {
        check: exactAnswer(marker),
      }),
      chat("same-user-same-session", session, recall, { check: exactAnswer(marker) }),
      chat("same-user-different-session", `${session}-other`, recall, { check: exactAnswer("UNKNOWN") }),
      chat("different-user-same-session", session, recall, { token: "B", check: exactAnswer("UNKNOWN") }),
    ];
  }

  if (profile === "rag") {
    const noEvidence = (body) => body.response === abstention &&
      Array.isArray(body.sources) && body.sources.length === 0 &&
      body.usage && typeof body.usage === "object" && !Array.isArray(body.usage) &&
      Object.keys(body.usage).length === 0 && !("stopReason" in body);
    const unsupported = "How do I configure Lambda container image signing failures?";
    return [
      chat("rag-supported", session, "What does ApproximateAgeOfOldestMessage mean for an SQS backlog?", {
        mode: "runbook",
        tokens: 1024,
        check: (body) => Array.isArray(body.sources) && body.sources.some((source) =>
          source?.documentId === "sqs-backlog" && source.chunkId === "sqs-backlog.metrics") &&
          body.response !== abstention,
      }),
      chat("rag-unsupported", `${session}-2`, unsupported, { mode: "runbook", check: noEvidence }),
      chat("rag-unsupported-repeat", `${session}-3`, unsupported, { mode: "runbook", check: noEvidence }),
    ];
  }

  if (profile === "tools") {
    const simulated = (...values) => (body) => body.response.startsWith(simulationNotice) &&
      values.every((value) => new RegExp(`\\b${value}\\b`).test(body.response));
    return [
      chat("simulated-sqs", session,
        "Use get_sqs_queue_status for orders-demo. Report the simulated visible and in-flight message counts as digits.",
        { check: simulated(12, 2) }),
      chat("simulated-lambda", `${session}-2`,
        "Use get_lambda_function_status for chat-demo. Report the simulated time window, invocations, errors and throttles as digits.",
        { check: simulated(5, 42, 1, 0) }),
      chat("plain-chat-with-tools-enabled", `${session}-3`, "Reply with only READY.", { check: exactAnswer("READY") }),
    ];
  }

  throw new Error("Choose one profile: baseline, rag, or tools.");
}

function resolveEndpoint(value) {
  const endpoint = URL.canParse(value ?? "") ? new URL(value) : undefined;
  if (!endpoint || endpoint.origin !== `https://${endpoint.hostname}` ||
      endpoint.href !== `${endpoint.origin}/` ||
      !/^[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(endpoint.hostname)) {
    throw new Error("AWS_SMOKE_URL must be the HTTPS execute-api base URL for the approved dev stage.");
  }
  return endpoint.origin;
}

export async function runSmoke(profile, {
  live = false,
  env = process.env,
  request = fetch,
  wait = delay,
  report = console.log,
} = {}) {
  const probes = makeProbes(profile);
  if (!live) {
    for (const probe of probes) {
      report(`DRY RUN ${probe.label} ${probe.path} expects HTTP ${probe.expectedStatus}`);
    }
    return;
  }

  const endpoint = resolveEndpoint(env.AWS_SMOKE_URL);
  const tokenA = env.AWS_SMOKE_JWT_A;
  const tokenB = env.AWS_SMOKE_JWT_B;
  const jwt = /^[\w-]+\.[\w-]+\.[\w-]+$/;
  if (!jwt.test(tokenA ?? "") || (profile === "baseline" && (!jwt.test(tokenB ?? "") || tokenA === tokenB))) {
    throw new Error("Provide AWS_SMOKE_JWT_A and, for baseline, a distinct JWT in AWS_SMOKE_JWT_B.");
  }
  const tokens = { A: tokenA, B: tokenB, invalid: "invalid-smoke-token" };

  for (const [index, probe] of probes.entries()) {
    if (index > 0) await wait(1000);
    const headers = {};
    if (probe.token) headers.Authorization = `Bearer ${tokens[probe.token]}`;
    if (probe.payload) headers["Content-Type"] = "application/json";

    let response;
    try {
      response = await request(endpoint + probe.path, {
        method: probe.payload ? "POST" : "GET",
        headers,
        body: JSON.stringify(probe.payload),
        redirect: "error",
        signal: AbortSignal.timeout(35_000),
      });
    } catch {
      throw new Error(`${probe.label} failed during the HTTP request. Check the deployment before retrying.`);
    }

    const id = response.headers.get("apigw-requestid") ?? response.headers.get("x-amzn-requestid");
    const requestId = id && /^[a-zA-Z0-9_+=/-]{1,100}$/.test(id) ? ` requestId=${id}` : "";
    const result = `${probe.label} HTTP ${response.status}${requestId}`;
    let passed = false;
    try {
      passed = response.status === probe.expectedStatus && (!probe.check || probe.check(await response.json()));
    } catch {
      // Response parsing and checks must never print response content.
    } finally {
      await response.body?.cancel().catch(() => {});
    }
    if (!passed) throw new Error(`FAIL ${result} (expected HTTP ${probe.expectedStatus} and response checks to pass)`);
    report(`PASS ${result}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [profile, ...options] = process.argv.slice(2);
  if (!profile || options.length > 1 || (options.length === 1 && !["--dry-run", "--live"].includes(options[0]))) {
    console.error("Usage: node scripts/smoke_aws.mjs <baseline|rag|tools> [--dry-run|--live]");
    process.exitCode = 1;
  } else {
    try {
      await runSmoke(profile, { live: options[0] === "--live" });
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
