export interface RunbookChunk {
  readonly documentId: string;
  readonly version: string;
  readonly chunkId: string;
  readonly title: string;
  readonly section: string;
  readonly text: string;
  readonly keywords?: readonly string[];
}

// Original, public-safe reference procedures, not live telemetry or incident data.
// Hand-authored boundaries keep prerequisites and warnings with each procedure.
// Change a document's version when its content changes; keep chunk IDs stable.
export const runbookCorpus: readonly RunbookChunk[] = Object.freeze([
  {
    documentId: "sqs-backlog", version: "1", chunkId: "sqs-backlog.metrics",
    title: "SQS Backlog Troubleshooting", section: "Backlog depth and oldest message age",
    keywords: ["ApproximateAgeOfOldestMessage", "ApproximateNumberOfMessagesVisible", "waiting messages"],
    text: "For an SQS backlog, compare ApproximateNumberOfMessagesVisible (waiting messages) with ApproximateAgeOfOldestMessage (oldest unprocessed message age in seconds) over the same time window. An increasing age can indicate delayed processing even with a small queue depth. These metrics are approximate. Repeatedly failing messages in standard queues can be excluded from the age metric; inspect failures and the DLQ too. Confirm the queue, Region, and metric dimensions before drawing conclusions.",
  },
  {
    documentId: "sqs-backlog", version: "1", chunkId: "sqs-backlog.consumers",
    title: "SQS Backlog Troubleshooting", section: "Consumers cannot keep up with incoming work",
    keywords: ["workers", "pile up", "backlog", "throughput"],
    text: "When SQS messages pile up, compare incoming work with successful consumer processing over the same interval. Check that consumers are running and the Lambda event source mapping is enabled. Investigate Lambda errors, throttling, and slow downstream dependencies. Workers cannot keep up when processing capacity is below arrival rate. Increase concurrency only after checking downstream capacity and applicable limits; reduce producer load if needed. Do not purge the queue to hide the backlog: purging loses work.",
  },
  {
    documentId: "sqs-backlog", version: "1", chunkId: "sqs-backlog.visibility",
    title: "SQS Backlog Troubleshooting", section: "Visibility timeout and repeated delivery",
    keywords: ["visibility timeout", "VisibilityTimeout"],
    text: "The SQS visibility timeout hides a received message while a consumer processes it. If it expires before successful processing and deletion, the message can be received again. For a Lambda SQS event source, AWS recommends at least six times the function timeout plus the configured batching window. The function timeout must not exceed the queue visibility timeout. Check processing duration before changing settings; longer visibility also delays retries after failures. Keep processing idempotent because duplicate delivery remains possible.",
  },
  {
    documentId: "sqs-backlog", version: "1", chunkId: "sqs-backlog.inflight",
    title: "SQS Backlog Troubleshooting", section: "In flight messages remain invisible",
    keywords: ["ApproximateNumberOfMessagesNotVisible", "received messages", "inflight"],
    text: "ApproximateNumberOfMessagesNotVisible estimates SQS messages received but not yet deleted or expired from visibility. These in flight messages are invisible while the consumer is working. If this count stays high, inspect slow or stuck consumers, processing duration, deletion failures, and visibility settings. A low visible count alone does not prove the queue is drained. Avoid reducing visibility just to make messages visible: that can trigger concurrent duplicate processing.",
  },
  {
    documentId: "lambda-failures", version: "1", chunkId: "lambda-failures.errors",
    title: "Lambda Failures and Throttling", section: "Errors, exceptions, and function crashes",
    keywords: ["Errors", "Invocations", "error rate", "crashes"],
    text: "For Lambda function crashes and exceptions, compare the Sum of Errors with the Sum of Invocations over the same period; Errors divided by Invocations gives an error rate when invocations are nonzero. Inspect authorized logs for exception types and recent code or configuration changes. Use request IDs for correlation and avoid copying payloads, credentials, or sensitive responses. Throttled invocation requests are not counted as Errors or Invocations. Reproduce with synthetic inputs before selecting a fix.",
  },
  {
    documentId: "lambda-failures", version: "1", chunkId: "lambda-failures.throttling",
    title: "Lambda Failures and Throttling", section: "Throttling and concurrency exhaustion",
    keywords: ["Throttles", "ConcurrentExecutions", "TooManyRequestsException", "rejected", "too many executions"],
    text: "Lambda throttling can reject function requests when too many executions run at once and available concurrency is exhausted. Compare Throttles with ConcurrentExecutions, reserved concurrency, and account concurrency usage. Check SQS event source maximum concurrency against available function capacity; throttling can increase a queue backlog. Reserved concurrency of zero prevents execution. Before raising concurrency, check downstream capacity. Smooth incoming load or reduce processing duration where possible, and verify recovery over a consistent metric window.",
  },
  {
    documentId: "lambda-failures", version: "1", chunkId: "lambda-failures.duration",
    title: "Lambda Failures and Throttling", section: "Duration and function timeouts",
    keywords: ["Duration", "running out of time", "slow downstream", "timed out"],
    text: "When a Lambda function runs out of time, compare Duration with the configured function timeout and inspect slow downstream requests. Bound network timeouts and retry attempts so they fit within the remaining execution time. Check dependency latency and resource use before increasing the function timeout. For SQS consumers, review the queue visibility timeout together with the function timeout. A timeout does not prove that downstream work was rolled back; use idempotent operations before retrying.",
  },
  {
    documentId: "lambda-failures", version: "1", chunkId: "lambda-failures.batch",
    title: "Lambda Failures and Throttling", section: "Partial batch failures and successful record retries",
    keywords: ["ReportBatchItemFailures", "batchItemFailures", "partial batch response"],
    text: "By default, a failed Lambda SQS batch causes successful records to be retried too. Enable ReportBatchItemFailures on the event source mapping and return failed message IDs in batchItemFailures to retry only failed records. Both configuration and handler response are required; an unhandled exception fails the entire batch. For FIFO queues, stop after the first failure and include failed and unprocessed records to preserve ordering. Keep processing idempotent and test mixed success and failure before enabling this recovery behavior.",
  },
  {
    documentId: "retry-dlq", version: "1", chunkId: "retry-dlq.policy",
    title: "Retry and DLQ Recovery", section: "Redrive policy and poison message isolation",
    keywords: ["maxReceiveCount", "dead letter queue", "poison messages"],
    text: "An SQS redrive policy sends repeatedly unsuccessful messages to a dead letter queue (DLQ) after the configured maxReceiveCount is exceeded. Allow enough receives for transient failures before isolating poison messages. Investigate the failure before changing this threshold; increasing it does not repair invalid data. For standard queues, expiration in the DLQ still uses the original enqueue time. Set DLQ retention longer than source retention to preserve investigation time. A FIFO DLQ can break exact operation order, so assess ordering requirements first.",
  },
  {
    documentId: "retry-dlq", version: "1", chunkId: "retry-dlq.redrive",
    title: "Retry and DLQ Recovery", section: "Safe redrive of quarantined messages",
    keywords: ["StartMessageMoveTask", "replay", "quarantined", "redrive"],
    text: "Before replaying quarantined SQS DLQ messages with StartMessageMoveTask, fix and test the consumer failure, confirm authorized queue and encryption permissions, and verify destination capacity and idempotency. Use a destination of the same queue type. Start redrive at a low rate and monitor errors and backlog; stop the move task if failures increase. Stopping does not recall messages already moved. Redriven messages receive new message IDs and enqueue times, so use a stable business key for deduplication. Do not purge the DLQ as a recovery step.",
  },
  {
    documentId: "retry-dlq", version: "1", chunkId: "retry-dlq.idempotency",
    title: "Retry and DLQ Recovery", section: "Idempotency and duplicate side effects",
    keywords: ["idempotent", "deduplication", "processed again"],
    text: "SQS consumers must tolerate the same message being processed again. Avoid duplicate side effects by using a stable business operation key and durable idempotency state. Coordinate the side effect and completion record atomically where possible; a simple check then write can race between concurrent consumers. Handle interrupted operations explicitly and retain deduplication records for the expected retry and replay window. Test repeated and concurrent deliveries. Do not assume that a new transport message ID means new business work after DLQ redrive.",
  },
  {
    documentId: "retry-dlq", version: "1", chunkId: "retry-dlq.backoff",
    title: "Retry and DLQ Recovery", section: "Bounded retries for transient downstream failures",
    keywords: ["temporary", "exponential backoff", "jitter", "retry storm"],
    text: "For temporary downstream failures, retry only operations that are safe to repeat. Use bounded exponential backoff with jitter, a maximum attempt count, and an overall time budget to avoid a retry storm. Permanent validation failures need correction rather than endless retries. Account for SDK retries and SQS redelivery together so nested retry loops do not multiply load. Do not sleep through a Lambda execution budget; let the queue retry when appropriate. Isolate repeated failures in a DLQ and investigate before replaying them.",
  },
].map((chunk) => Object.freeze({ ...chunk, keywords: Object.freeze(chunk.keywords) })));
