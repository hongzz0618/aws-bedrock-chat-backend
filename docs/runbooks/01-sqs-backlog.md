---
documentId: sqs-backlog
version: "1"
---

# SQS Backlog Troubleshooting

## Backlog depth and oldest message age
<!--
chunkId: sqs-backlog.metrics
keywords: ["ApproximateAgeOfOldestMessage", "ApproximateNumberOfMessagesVisible", "waiting messages"]
-->

For an SQS backlog, compare ApproximateNumberOfMessagesVisible (waiting messages) with ApproximateAgeOfOldestMessage (oldest unprocessed message age in seconds) over the same time window. An increasing age can indicate delayed processing even with a small queue depth. These metrics are approximate. Repeatedly failing messages in standard queues can be excluded from the age metric; inspect failures and the DLQ too. Confirm the queue, Region, and metric dimensions before drawing conclusions.

## Consumers cannot keep up with incoming work
<!--
chunkId: sqs-backlog.consumers
keywords: ["workers", "pile up", "backlog", "throughput"]
-->

When SQS messages pile up, compare incoming work with successful consumer processing over the same interval. Check that consumers are running and the Lambda event source mapping is enabled. Investigate Lambda errors, throttling, and slow downstream dependencies. Workers cannot keep up when processing capacity is below arrival rate. Increase concurrency only after checking downstream capacity and applicable limits; reduce producer load if needed. Do not purge the queue to hide the backlog: purging loses work.

## Visibility timeout and repeated delivery
<!--
chunkId: sqs-backlog.visibility
keywords: ["visibility timeout", "VisibilityTimeout"]
-->

The SQS visibility timeout hides a received message while a consumer processes it. If it expires before successful processing and deletion, the message can be received again. For a Lambda SQS event source, AWS recommends at least six times the function timeout plus the configured batching window. The function timeout must not exceed the queue visibility timeout. Check processing duration before changing settings; longer visibility also delays retries after failures. Keep processing idempotent because duplicate delivery remains possible.

## In flight messages remain invisible
<!--
chunkId: sqs-backlog.inflight
keywords: ["ApproximateNumberOfMessagesNotVisible", "received messages", "inflight"]
-->

ApproximateNumberOfMessagesNotVisible estimates SQS messages received but not yet deleted or expired from visibility. These in flight messages are invisible while the consumer is working. If this count stays high, inspect slow or stuck consumers, processing duration, deletion failures, and visibility settings. A low visible count alone does not prove the queue is drained. Avoid reducing visibility just to make messages visible: that can trigger concurrent duplicate processing.
