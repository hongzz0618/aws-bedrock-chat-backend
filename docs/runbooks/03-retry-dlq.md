---
documentId: retry-dlq
version: "1"
---

# Retry and DLQ Recovery

## Redrive policy and poison message isolation
<!--
chunkId: retry-dlq.policy
keywords: ["maxReceiveCount", "dead letter queue", "poison messages"]
-->

An SQS redrive policy sends repeatedly unsuccessful messages to a dead letter queue (DLQ) after the configured maxReceiveCount is exceeded. Allow enough receives for transient failures before isolating poison messages. Investigate the failure before changing this threshold; increasing it does not repair invalid data. For standard queues, expiration in the DLQ still uses the original enqueue time. Set DLQ retention longer than source retention to preserve investigation time. A FIFO DLQ can break exact operation order, so assess ordering requirements first.

## Safe redrive of quarantined messages
<!--
chunkId: retry-dlq.redrive
keywords: ["StartMessageMoveTask", "replay", "quarantined", "redrive"]
-->

Before replaying quarantined SQS DLQ messages with StartMessageMoveTask, fix and test the consumer failure, confirm authorized queue and encryption permissions, and verify destination capacity and idempotency. Use a destination of the same queue type. Start redrive at a low rate and monitor errors and backlog; stop the move task if failures increase. Stopping does not recall messages already moved. Redriven messages receive new message IDs and enqueue times, so use a stable business key for deduplication. Do not purge the DLQ as a recovery step.

## Idempotency and duplicate side effects
<!--
chunkId: retry-dlq.idempotency
keywords: ["idempotent", "deduplication", "processed again"]
-->

SQS consumers must tolerate the same message being processed again. Avoid duplicate side effects by using a stable business operation key and durable idempotency state. Coordinate the side effect and completion record atomically where possible; a simple check then write can race between concurrent consumers. Handle interrupted operations explicitly and retain deduplication records for the expected retry and replay window. Test repeated and concurrent deliveries. Do not assume that a new transport message ID means new business work after DLQ redrive.

## Bounded retries for transient downstream failures
<!--
chunkId: retry-dlq.backoff
keywords: ["temporary", "exponential backoff", "jitter", "retry storm"]
-->

For temporary downstream failures, retry only operations that are safe to repeat. Use bounded exponential backoff with jitter, a maximum attempt count, and an overall time budget to avoid a retry storm. Permanent validation failures need correction rather than endless retries. Account for SDK retries and SQS redelivery together so nested retry loops do not multiply load. Do not sleep through a Lambda execution budget; let the queue retry when appropriate. Isolate repeated failures in a DLQ and investigate before replaying them.
