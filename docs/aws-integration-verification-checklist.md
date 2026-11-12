# Controlled AWS Dev validation

Status: planned. The [earlier AWS validation](deployment-validation.md) covers the text-only deployment. [Offline tests](rag-phase1-evaluation.md) establish retrieval behavior and mocked integration. This checklist covers the current deployment and real model behavior.

## Before using AWS

- [ ] Approve the dedicated account, Region, deployment and feature updates, model call budget, test identities and cleanup. Assign one operator and a time window. Use synthetic inputs and two Cognito users with distinct `sub` values.
- [ ] Build and verify the Lambda ZIP locally. Confirm model entitlement and inference-profile access. Review the Terraform plan against the intended dev state, including scoped IAM, route authorization, TTL, log retention and budget notifications. Confirm the alarm subscription where configured.
- [ ] Start with `rag_enabled = false` and `tool_calling_enabled = false`. Verify the deployed Lambda environment values and the API's `$default` stage default route settings. The default dev target is 2 requests/second and burst 5. To override it, set `api_throttling = { rate_limit = 2, burst_limit = 5 }` with approved values.
- [ ] Check that the effective Bedrock SDK attempt limit is at most three when Tool Calling is disabled. Check the pricing for the approved model and Region and agree on a monetary stop threshold. API Gateway throttles on a best-effort basis and can return 429. Budget notifications can arrive after charges accrue. Neither is a hard spending cap. [HTTP API throttling](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-throttling.html), [AWS Budgets](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html), [SDK attempt limits](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html)

After approval, initialize Terraform against the designated dev state. Use `terraform -chdir=live/dev plan -out=validation.tfplan` to prepare each reviewed deployment or flag change. Treat plan files and state as sensitive.

## Smoke tests

Preview all probes on Node.js 22 without credentials or network requests.

```bash
node scripts/smoke_aws.mjs baseline --dry-run
node scripts/smoke_aws.mjs rag --dry-run
node scripts/smoke_aws.mjs tools --dry-run
```

After deployment approval, set `AWS_SMOKE_URL` to the approved HTTPS execute-api base URL from the dev root's `api_url` output. Obtain the short-lived test JWTs through the approved sign-in flow. In an interactive Bash shell with tracing off, read each token without echoing it or putting it on the command line. B is used only by `baseline`.

```bash
set +x
read -rs -p "Test user A JWT: " AWS_SMOKE_JWT_A
printf '\n'
read -rs -p "Test user B JWT: " AWS_SMOKE_JWT_B
printf '\n'
export AWS_SMOKE_URL AWS_SMOKE_JWT_A AWS_SMOKE_JWT_B
```

Run each profile once after verifying its deployed flag settings. The script runs one probe at a time, waits a second between requests, and stops on the first mismatch or HTTP failure without retrying. It reports probe names, status codes and API request IDs when available. Use those IDs and the test window to find evidence. JWTs and response bodies stay out of the script output.

| Profile and command | Flags | Expected results | Evidence to keep |
| --- | --- | --- | --- |
| `node scripts/smoke_aws.mjs baseline --live` | Both off | Health 200. Missing and invalid JWTs each return 401. Invalid sampling and disabled Runbook mode return a generic 400. A learns and recalls a fresh marker in one session. A in another session and B reusing A's session ID both return `UNKNOWN`. | Record access statuses and the authorized cold-start result. For the 401s, confirm the requests did not reach the Lambda integration. For 400s, confirm no model or DynamoDB work. Check the stored turns and history counts below. |
| `node scripts/smoke_aws.mjs rag --live` | RAG on, tools off | Evaluation case 1 returns HTTP 200 with `sqs-backlog.metrics` among its sources. Case 9 returns the fixed abstention twice with empty sources and usage and no `stopReason`. | Verify that structured source metadata matches the exact bundled excerpts, then use the rubric to score grounding separately. Check no history/tool use in Runbook mode. Review abstention telemetry for zero Bedrock latency and no token metrics, and confirm the abstained turns were persisted. |
| `node scripts/smoke_aws.mjs tools --live` | RAG off, tools on | SQS fixture for `orders-demo` reports 12 visible and 2 in flight. Lambda fixture for `chat-demo` reports 42 invocations, 1 error and 0 throttles over 5 minutes. Both responses carry the simulation notice. The plain-chat probe returns `READY`. | Check positive tool requests and rounds for both fixture probes, zero failures, and no tool requests for plain chat. Review the synthetic answers in restricted storage for correct field-to-value mapping. The script checks the notice and digit presence. Both tools use fixtures without live telemetry permissions. |

For the DynamoDB check, use authorized read-only access and restrict it to the two test users and their generated session prefixes. Locate test rows using the run window and request correlation. Confirm A has two rows under the original session and one under the alternate session. B should have one row under its own partition with the original session ID. Review `expires_at` and table TTL settings. For tool requests, confirm the stored conversation content is the original synthetic prompt and final answer. Keep only redacted counts, boundary checks and TTL metadata in shared evidence. DynamoDB deletes expired items asynchronously.

For CloudWatch, correlate API access logs and Lambda events by request ID. Record latency, history turn counts, `ChatRequestCount`, `ChatSuccessCount`, `ChatFailureCount`, `BedrockLatency`, `InputTokens`, `OutputTokens` and relevant tool counters in the `aws-bedrock-chat-backend` namespace where emitted. Check that logs omit JWTs, prompts, history, tool arguments/results and model output. Allow for metric delivery delay. A model-backed request with no token metrics or a no-evidence request with token usage needs investigation.

For upstream failure cases, review the mocked sanitized 500/502/503, rejected tool requests, no partial turn on terminal failure, and the bounded tool loop (three Converse calls, two rounds, four tool requests, and a shared deadline of up to 10 seconds). If any upstream failure occurs during the live run, capture the sanitized public status and error category, check for partial writes, and stop. Verify the live throttle setting from stage configuration and capture 429 evidence only if observed. A load test requires its own scope and request budget.

## Model quality evaluation

Use the [12 RAG cases, settings and A–F scoring rubric](rag-phase1-evaluation.md#future-approved-live-evaluation--not-tested) as written. Run cases 1–7 and 11 three times each through Runbook mode with RAG on and tools off. Use a fresh session for every prompt, temperature 0 and 1,024 max output tokens. Run each no-call case (8–10) once, and record case 8 as a retrieval miss if it still abstains. Case 12 needs a separately approved isolated Converse harness. Reproduce the local context and system instruction, alter only the designated excerpt in the isolated request, and limit the harness to one SDK attempt per call. Keep the deployed corpus and API unchanged.

In the approved evaluation client, send an authenticated `POST /chat` with this shape and substitute the exact case prompt and a unique session ID each time.

```json
{"mode":"runbook","session_id":"evaluation-01-repeat-1","prompt":"What does ApproximateAgeOfOldestMessage mean for an SQS backlog?","temperature":0,"max_tokens":1024}
```

For each model-backed repeat, record the deployed commit, model profile, Region, exact excerpts after context filtering, request settings, sources, response and A–F scores in a restricted evaluation record. Use `npm run runbooks:demo -- "<exact case prompt>"` on the matching revision to reproduce the supplied excerpts and check the response sources. Reconstruct the complete synthetic model request with `buildRunbookContext` and keep it with the response in the restricted record. Keep JWTs, production data and raw transcripts out of logs and shared reports. Use the rubric's acceptance thresholds and record skipped cases as pending.

## Call budget and manual stops

| Window | Maximum planned probes | Bedrock allowance |
| --- | --- | --- |
| Integration smoke | 15 HTTP requests across three profiles | At most 14 application-level Converse calls. Budget up to 24 SDK attempts (5 plain/RAG calls × 3 attempts, plus up to 9 tool-enabled calls × 1 attempt). |
| Separate RAG quality evaluation | 27 HTTP requests plus up to 3 direct harness calls | At most 27 application-level Converse calls. Budget up to 75 SDK attempts (24 model-backed API calls × 3 attempts, plus 3 harness calls × 1 attempt). |

Use one operator, serial requests and a running tally. Include attempts that time out and any additional manual model probes in the agreed allowance. The counts are planning bounds for these probes under the stated settings. Stop on the first unexpected status (including 429 or 5xx), timeout, isolation failure, missing evidence, fabricated observation or source, injection compliance, or when the time, call or cost allowance is reached. Investigate before authorizing a retry or extending the session. Review observed usage and the estimated cost after each profile or evaluation batch.

## Cleanup and evidence

- [ ] Stop requests. Return both flags to `false` through the approved change process if the environment is retained. Revoke test access, remove temporary users and test data as approved, and clear the shell variables with `unset AWS_SMOKE_URL AWS_SMOKE_JWT_A AWS_SMOKE_JWT_B`.
- [ ] For a temporary deployment, prepare and review `terraform -chdir=live/dev plan -destroy -out=validation-cleanup.tfplan` for the approved state only. After approved teardown, verify Terraform state and check for remaining API, Lambda, log, DynamoDB, Cognito and monitoring resources. Account-level model access is outside the Terraform state. Review billing again after usage has posted.
- [ ] Store sanitized evidence separately from the [historical text-only record](deployment-validation.md). Record the revision, settings, time window, observed outcomes, call tally, cost estimate, cleanup and pending checks.
