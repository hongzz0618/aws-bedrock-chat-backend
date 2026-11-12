# ADR 005 — Independent flags for RAG and simulated Tool Calling

## Context

Runbook mode changes the evidence sent to the model. Tool Calling adds a model-driven loop to regular chat. Each adds a different validation and cost profile to the existing text chat path.

## Decision

Keep `rag_enabled` and `tool_calling_enabled` independent in dev Terraform, both defaulting to `false`. A client selects Runbook mode explicitly when the RAG flag is on. Runbook requests always bypass conversation history and Tool Calling. The Tool Calling flag allows regular chat to advertise the two read-only fixture tools, with a bounded number of rounds and model calls.

## Consequences

Operators can validate and roll back each path independently while keeping the same JWT, IAM and persistence boundaries. The simulator needs no permissions to query live AWS telemetry. The default stage throttling targets and budget alerts help manage a short demonstration. Multiple model calls per tool conversation and SDK retries outside tool-enabled chat still affect the call budget.

Changing a flag requires an approved Terraform update. Use the [validation checklist](../aws-integration-verification-checklist.md) to test both features and restore their default-off state.
