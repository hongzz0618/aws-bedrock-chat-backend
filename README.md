# Authenticated Bedrock Chat Backend

[![CI](https://github.com/hongzz0618/aws-bedrock-chat-backend/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hongzz0618/aws-bedrock-chat-backend/actions/workflows/ci.yml)

## Project Overview

A TypeScript serverless chat API that connects authenticated users to Amazon
Bedrock Converse and keeps each user's conversation history isolated. It
demonstrates how to build an AI backend with bounded requests, persistent
sessions, and operational telemetry on AWS.

## Key Features

- **Authentication and isolation.** API Gateway validates Cognito JWTs for
  chat. Lambda derives user identity from the authenticated JWT `sub` claim.
  DynamoDB history is scoped to that user and session, so users can reuse the
  same session ID without sharing history.
  Clients cannot supply their own user identity or choose the model.
- **Bounded conversations.** Lambda validates request fields, selects recent
  complete turns within a character budget, and stores the prompt and final
  answer with a DynamoDB TTL.
- **Bedrock Tool Calling.** An optional, bounded Converse loop validates model
  requests and runs two allowlisted, simulated tools.
- **Operations.** CloudWatch receives structured logs and EMF metrics for
  requests, failures, latency, and token usage. Lambda logs omit JWTs, prompts,
  chat history, and raw tool results. Terraform defines the dev infrastructure.

## Architecture

```mermaid
flowchart LR
    Client -->|"Sign in"| Cognito["Amazon Cognito"]
    Cognito -->|"JWT"| Client
    Client -->|"HTTPS"| API["API Gateway HTTP API"]
    API -->|"JWT required for POST /chat"| Lambda["TypeScript Lambda"]
    Lambda <-->|"Converse"| Bedrock["Amazon Bedrock"]
    Lambda <-->|"User and session history + TTL"| DynamoDB[("DynamoDB")]
    Lambda -->|"JSON logs and EMF metrics"| CloudWatch["CloudWatch"]
```

For chat, Lambda loads bounded history before calling Bedrock and writes a turn
after it receives a non-empty final answer. The
[session isolation ADR](docs/adr/001-authenticated-session-isolation.md) and
[context and retention ADR](docs/adr/002-bounded-context-and-retention.md)
explain the storage and context decisions.

## API & Tool Calling

| Endpoint | Access | Purpose |
| --- | --- | --- |
| `GET /health` | Public | Liveness check |
| `POST /chat` | Cognito bearer JWT | Send a prompt and optionally reuse a session |

For an approved deployment, set `API_URL` and `JWT` in your shell before using
this example:

```bash
curl -X POST "${API_URL}/chat" \
  -H "Authorization: Bearer ${JWT}" \
  -H "Content-Type: application/json" \
  -d '{"session_id":"demo-session","prompt":"Give a short greeting."}'
```

A successful response includes the session ID, answer, and usage metadata.
See [OpenAPI](openapi/openapi.yaml) for request limits and error responses.

### Simulated tools

| Tool | Fixture data |
| --- | --- |
| `get_sqs_queue_status` | Queue counts for `orders-demo` |
| `get_lambda_function_status` | Function metrics for `chat-demo` |

When enabled, Lambda sends tool definitions to Bedrock, validates any
`toolUse` request, and returns a matching `toolResult` before asking Bedrock
for the final answer. The loop bounds calls, rounds, requests, execution time,
payload sizes, and generated tokens. DynamoDB stores the original prompt and
final answer as conversation content.

Both tools are read-only and use deterministic fixtures. They make no live
SQS, Lambda, or CloudWatch queries. The backend labels answers that use fixture
data as simulated. The server-side `TOOL_CALLING_ENABLED` flag defaults to
`false`. Terraform-managed activation is deferred.

## Testing & Validation

- **Local and CI.** Vitest covers chat behavior, session isolation, the API
  contract, and [mocked Tool Calling](tests/toolConversation.test.ts).
  [CI](.github/workflows/ci.yml) also checks the Lambda build and package and
  runs Terraform plan tests with a mocked AWS provider.
- **Prior live AWS validation.** A temporary dev deployment in `eu-west-1`
  verified the earlier text-only chat path, including Cognito authorization,
  Bedrock invocation, DynamoDB history and TTL metadata, and CloudWatch
  telemetry. The environment was torn down after validation. The
  [validation report](docs/deployment-validation.md) preserves the results and
  sanitized screenshots.
- **Live Tool Calling remains unverified.** The
  [AWS integration checklist](docs/aws-integration-verification-checklist.md)
  describes a future controlled validation session.

## Local Development

Use Node.js 22 to match CI. These checks run without AWS credentials:

```bash
npm ci
npm run typecheck
npm test
npm run contract:validate
npm run build
```

See the [CI workflow](.github/workflows/ci.yml) for the Lambda packaging and
Terraform checks.

## Documentation & Limitations

- [Architecture decisions](docs/adr/) cover session isolation, bounded context,
  retention, and Bedrock sampling compatibility.
- [Dev infrastructure](live/dev/) contains the Terraform configuration.
- [AWS validation evidence](docs/evidence/) contains the earlier text-only
  deployment screenshots.

This is a backend reference. RAG, streaming, and a frontend are outside the
current implementation. DynamoDB TTL deletion is asynchronous, and budget
alerts and request limits do not enforce a hard spending cap.
