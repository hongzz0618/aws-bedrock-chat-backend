---
documentId: lambda-failures
version: "1"
---

# Lambda Failures and Throttling

## Errors, exceptions, and function crashes
<!--
chunkId: lambda-failures.errors
keywords: ["Errors", "Invocations", "error rate", "crashes"]
-->

For Lambda function crashes and exceptions, compare the Sum of Errors with the Sum of Invocations over the same period; Errors divided by Invocations gives an error rate when invocations are nonzero. Inspect authorized logs for exception types and recent code or configuration changes. Use request IDs for correlation and avoid copying payloads, credentials, or sensitive responses. Throttled invocation requests are not counted as Errors or Invocations. Reproduce with synthetic inputs before selecting a fix.

## Throttling and concurrency exhaustion
<!--
chunkId: lambda-failures.throttling
keywords: ["Throttles", "ConcurrentExecutions", "TooManyRequestsException", "rejected", "too many executions"]
-->

Lambda throttling can reject function requests when too many executions run at once and available concurrency is exhausted. Compare Throttles with ConcurrentExecutions, reserved concurrency, and account concurrency usage. Check SQS event source maximum concurrency against available function capacity; throttling can increase a queue backlog. Reserved concurrency of zero prevents execution. Before raising concurrency, check downstream capacity. Smooth incoming load or reduce processing duration where possible, and verify recovery over a consistent metric window.

## Duration and function timeouts
<!--
chunkId: lambda-failures.duration
keywords: ["Duration", "running out of time", "slow downstream", "timed out"]
-->

When a Lambda function runs out of time, compare Duration with the configured function timeout and inspect slow downstream requests. Bound network timeouts and retry attempts so they fit within the remaining execution time. Check dependency latency and resource use before increasing the function timeout. For SQS consumers, review the queue visibility timeout together with the function timeout. A timeout does not prove that downstream work was rolled back; use idempotent operations before retrying.

## Partial batch failures and successful record retries
<!--
chunkId: lambda-failures.batch
keywords: ["ReportBatchItemFailures", "batchItemFailures", "partial batch response"]
-->

By default, a failed Lambda SQS batch causes successful records to be retried too. Enable ReportBatchItemFailures on the event source mapping and return failed message IDs in batchItemFailures to retry only failed records. Both configuration and handler response are required; an unhandled exception fails the entire batch. For FIFO queues, stop after the first failure and include failed and unprocessed records to preserve ordering. Keep processing idempotent and test mixed success and failure before enabling this recovery behavior.
