# AWS Integration Verification Checklist

Use this checklist for a future approved AWS validation session. Tool Calling
currently defaults off, uses simulated data, and has mocked test coverage.
Live Tool Calling and RAG remain unverified. Earlier
[AWS validation evidence](deployment-validation.md) covers text-only chat.

## 1. Preconditions

- [ ] Obtain explicit approval for deployment, live Bedrock calls, and cleanup.
- [ ] Confirm the test account, region, operator permissions, and access to the configured Bedrock model.
- [ ] Agree on a spending limit, request cap, and stop condition. Assign an owner for cost tracking and cleanup.
- [ ] Select test scenarios, test users, and the resources approved for teardown. Include RAG only if its implementation is ready and separately approved.
- [ ] Approve a Terraform-managed activation change before the session. The current Terraform does not configure the Tool Calling flag.

## 2. Infrastructure and Configuration

- [ ] Review the Terraform plan and confirm `TOOL_CALLING_ENABLED=true` is limited to the approved test environment, with a path back to `false`.
- [ ] Verify Lambda environment variables and scoped IAM access for Bedrock and DynamoDB. Confirm the tool registry contains only the two simulated tools and has no live tool access.
- [ ] Confirm `GET /health` is public and `POST /chat` rejects missing or invalid Cognito JWTs.

## 3. Functional Verification

- [ ] With a valid JWT, prompt for the `orders-demo` queue and `chat-demo` function in separate requests. Confirm both `get_sqs_queue_status` and `get_lambda_function_status` return the expected fixture values and the final answers carry the simulation notice.
- [ ] Confirm the Converse flow completes from `toolUse` through backend validation, dispatch, and matching `toolResult` to the final answer.
- [ ] Reuse a session with the same user, then with a second user. Confirm the first user can recover history and the second cannot see it. Check that only the original prompt and final answer are stored as conversation content, with TTL.
- [ ] Send a text-only prompt with Tool Calling enabled, then repeat with it disabled. Expect the existing chat response shape and normal history behavior.

## 4. Reliability and Observability

- [ ] Check the limits of three Converse calls, two tool rounds, four tool requests, and a shared deadline of up to 10 seconds with time reserved for Lambda to finish.
- [ ] Use controlled invalid requests and failure cases. Expect rejected tools to stay unexecuted, sanitized errors, and no partial turn on a terminal failure. Record any case that could only be checked with mocks.
- [ ] Review CloudWatch structured logs and EMF metrics for tool counts, failures, latency, and cumulative token usage. Verify that logs omit JWTs, prompts, history, tool arguments, and raw tool results.
- [ ] Estimate session cost from observed usage and the rates for the approved model. Compare it with the agreed limit and stop if the threshold is reached.

## 5. Cleanup and Evidence

- [ ] Disable Tool Calling and confirm the flag is back to `false`.
- [ ] Destroy only resources approved for teardown. Verify cleanup and check for remaining resources or charges.
- [ ] Save sanitized results separately from earlier evidence. Record the commit, test window, features actually validated, outcomes, and anything skipped or unverified.
