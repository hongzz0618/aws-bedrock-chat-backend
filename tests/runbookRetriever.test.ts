import { describe, expect, it } from "vitest";
import { runbookCorpus, type RunbookChunk } from "../src-ts/runbookCorpus";
import {
  createRunbookRetriever,
  InvalidRunbookCorpusError,
  runbookRetriever,
} from "../src-ts/runbookRetriever";

// Fixed before implementing ranking. Expected IDs describe the evidence needed,
// not merely the document topic. Evaluate the chunks actually selected by budget.
const evaluation = [
  { id: "S1", category: "exact", query: "What does ApproximateAgeOfOldestMessage mean for an SQS backlog?", expected: ["sqs-backlog.metrics"] },
  { id: "S2", category: "exact", query: "How should I set the SQS visibility timeout for Lambda?", expected: ["sqs-backlog.visibility"] },
  { id: "S3", category: "paraphrase", query: "Messages pile up because workers cannot keep up. What should I check?", expected: ["sqs-backlog.consumers"] },
  { id: "S4", category: "paraphrase", query: "Why are received messages invisible while the consumer is still working?", expected: ["sqs-backlog.inflight", "sqs-backlog.visibility"] },
  { id: "S5", category: "paraphrase", query: "How can I investigate an increasing age of waiting messages?", expected: ["sqs-backlog.metrics"] },
  { id: "S6", category: "overlap", query: "Could Lambda throttling cause an SQS backlog?", expected: ["lambda-failures.throttling", "sqs-backlog.consumers"] },
  { id: "L1", category: "exact", query: "How do Lambda Errors and Invocations relate to the error rate?", expected: ["lambda-failures.errors"] },
  { id: "L2", category: "exact", query: "How do ConcurrentExecutions and Throttles help diagnose Lambda throttling?", expected: ["lambda-failures.throttling"] },
  { id: "L3", category: "paraphrase", query: "My function crashes with exceptions. Where should I investigate?", expected: ["lambda-failures.errors"] },
  { id: "L4", category: "paraphrase", query: "The function keeps running out of time during slow downstream requests. What should I check?", expected: ["lambda-failures.duration"] },
  { id: "L5", category: "paraphrase", query: "Function requests are rejected because too many executions run at once. What can I do?", expected: ["lambda-failures.throttling"] },
  { id: "L6", category: "overlap", query: "How does ReportBatchItemFailures prevent successful SQS records from being retried?", expected: ["lambda-failures.batch"] },
  { id: "D1", category: "exact", query: "What does maxReceiveCount do in an SQS redrive policy?", expected: ["retry-dlq.policy"] },
  { id: "D2", category: "exact", query: "What should I check before StartMessageMoveTask for DLQ redrive?", expected: ["retry-dlq.redrive"] },
  { id: "D3", category: "paraphrase", query: "How can I safely replay quarantined messages after fixing the consumer?", expected: ["retry-dlq.redrive"] },
  { id: "D4", category: "paraphrase", query: "How can I avoid duplicate side effects when the same message is processed again?", expected: ["retry-dlq.idempotency"] },
  { id: "D5", category: "paraphrase", query: "How should retries handle temporary downstream failures without a retry storm?", expected: ["retry-dlq.backoff"] },
  { id: "D6", category: "overlap", query: "A failed Lambda batch retries successful SQS records. How can I recover only failed records?", expected: ["lambda-failures.batch"] },
  { id: "U1", category: "abstention", query: "What is the live SQS backlog in my AWS account right now?", expected: [] },
  { id: "U2", category: "abstention", query: "How many Lambda Errors occurred in production today?", expected: [] },
  { id: "U3", category: "abstention", query: "How do I configure SQS encryption with automatic KMS key rotation?", expected: [] },
  { id: "U4", category: "abstention", query: "How do I configure Lambda container image signing?", expected: [] },
  { id: "U5", category: "abstention", query: "How do I replay an EventBridge archive?", expected: [] },
  { id: "U6", category: "abstention", query: "How do I configure cross region replication for a DLQ?", expected: [] },
] as const;

const options = { maxChunks: 3, maxEvidenceChars: 2400 };

const recallQueries = [
  { query: "Why is my SQS queue growing?", expected: ["sqs-backlog.consumers"] },
  { query: "My Lambda is being throttled and SQS messages are accumulating.", expected: ["lambda-failures.throttling", "sqs-backlog.consumers"] },
  { query: "What should I check now when SQS messages pile up?", expected: ["sqs-backlog.consumers"] },
  { query: "How do I redrive SQS DLQ messages after fixing the issue?", expected: ["retry-dlq.redrive"] },
  { query: "My Lambda function is getting throttled, and the SQS queue keeps growing. What should I check first?", expected: ["lambda-failures.throttling", "sqs-backlog.consumers"] },
];

describe("natural language recall and abstention regressions", () => {
  it.each(recallQueries)("retrieves useful evidence for $query", ({ query, expected }) => {
    const selected = runbookRetriever.retrieve({ query, ...options });
    const ids = selected.map((chunk) => chunk.chunkId);
    console.info(JSON.stringify({ query, selected: ids }));
    expect(ids).toEqual(expect.arrayContaining(expected));
    expect(selected.reduce((size, chunk) => size + chunk.text.length, 0)).toBeLessThanOrEqual(options.maxEvidenceChars);
  });

  it("keeps both Lambda and SQS evidence within a two-chunk budget", () => {
    const selected = runbookRetriever.retrieve({ query: recallQueries[4].query, maxChunks: 2, maxEvidenceChars: 1200 });
    expect(selected).toHaveLength(2);
    expect(selected.map((chunk) => chunk.chunkId)).toEqual(expect.arrayContaining(["lambda-failures.throttling", "sqs-backlog.consumers"]));
    expect(selected.reduce((size, chunk) => size + chunk.text.length, 0)).toBeLessThanOrEqual(1200);
  });

  it.each([
    "How do I troubleshoot current Lambda throttling?",
    "What should I check now for Lambda throttling?",
    "How can I investigate the current SQS backlog?",
  ])("allows time words in documented guidance: %s", (query) => {
    expect(runbookRetriever.retrieve({ query, ...options }).length).toBeGreaterThan(0);
  });

  it.each([
    "What is the current Lambda error rate?",
    "Show my SQS backlog",
    "How many messages are in my SQS queue?",
    "What should I check now, and show my live SQS backlog?",
    "How do I troubleshoot Lambda throttling, and what is the current error rate?",
    "How do I configure Lambda container image signing failures?",
    "Why is my garden growing?",
    "How do I replay a video?",
    "How do I rotate SQS encryption keys?",
    "How do I fix EventBridge archive replay failures?",
  ])("does not invent evidence for %s", (query) => {
    expect(runbookRetriever.retrieve({ query, ...options })).toEqual([]);
  });
});

describe("runbook retrieval evaluation", () => {
  it("meets each acceptance target on the fixed 24-question dataset", () => {
    const results = evaluation.map((entry) => {
      const selected = runbookRetriever.retrieve({ query: entry.query, ...options });
      const ids = selected.map((chunk) => chunk.chunkId);
      const correct = entry.expected.length === 0
        ? ids.length === 0
        : entry.expected.some((id) => ids.includes(id));
      expect(selected.length).toBeLessThanOrEqual(3);
      expect(selected.reduce((size, chunk) => size + chunk.text.length, 0)).toBeLessThanOrEqual(2400);
      return { ...entry, selected: ids.join(", ") || "(abstain)", correct };
    });
    // Keep every outcome visible, including any allowed paraphrase/overlap miss.
    console.table(results.map(({ id, category, selected, correct }) => ({ id, category, selected, correct })));
    const passed = (category: string) => results.filter((r) => r.category === category && r.correct).length;
    console.info(`Retrieval: exact ${passed("exact")}/6; paraphrase ${passed("paraphrase")}/9; overlap ${passed("overlap")}/3; abstention ${passed("abstention")}/6`);
    expect(evaluation).toHaveLength(24);
    expect(passed("exact")).toBe(6);
    expect(passed("exact") + passed("paraphrase") + passed("overlap")).toBeGreaterThanOrEqual(16);
    expect(passed("abstention")).toBe(6);
  });
});

// Additional fixed probes; keep the original 24-question benchmark unchanged.
const finalEvaluation = [
  { category: "paraphrase", query: "Workers cannot keep up with SQS messages. What should I investigate?", expected: ["sqs-backlog.consumers"] },
  { category: "multi-topic", query: "Lambda throttling and SQS backlog: what should I check?", expected: ["lambda-failures.throttling", "sqs-backlog.consumers"] },
  { category: "time-guidance", query: "How should I troubleshoot current Lambda throttling?", expected: ["lambda-failures.throttling"] },
  { category: "time-guidance", query: "What should I check now for an SQS backlog?", expected: ["sqs-backlog.consumers"] },
  { category: "configuration", query: "How many retries should I allow before moving a message to the DLQ?", expected: ["retry-dlq.policy"], knownMiss: true },
  { category: "configuration", query: "How many receives should I configure for maxReceiveCount?", expected: ["retry-dlq.policy"] },
  { category: "recovery", query: "How can I safely replay quarantined SQS messages?", expected: ["retry-dlq.redrive"] },
  { category: "telemetry", query: "How many retries occurred in my SQS queue today?", expected: [] },
  { category: "telemetry", query: "How many retries should I allow, and how many Lambda Errors occurred today?", expected: [] },
  { category: "telemetry", query: "How many receives should I configure for maxReceiveCount, and show my live SQS backlog?", expected: [] },
  { category: "telemetry", query: "How many Lambda Errors can you see today?", expected: [] },
  { category: "telemetry", query: "How many Lambda Errors occurred and how many receives should I configure for maxReceiveCount?", expected: [] },
  { category: "outside", query: "How do I configure Kubernetes autoscaling?", expected: [] },
  { category: "unsupported-related", query: "How do I configure Lambda container image signing failures?", expected: [] },
  { category: "insufficient", query: "Lambda SQS", expected: [] },
  { category: "empty", query: "", expected: [] },
];

it("reports final retrieval probes including known misses and false positives", () => {
  const results = finalEvaluation.map((entry) => {
    const selected = runbookRetriever.retrieve({ query: entry.query, maxChunks: 3, maxEvidenceChars: 3000 });
    const ids = selected.map((c) => c.chunkId);
    const correct = entry.expected.length ? entry.expected.every((id) => ids.includes(id)) : ids.length === 0;
    return { category: entry.category, query: entry.query, selected: ids.join(","), correct,
      miss: entry.expected.length > 0 && !correct, falsePositive: entry.expected.length === 0 && ids.length > 0,
      toleratedMiss: entry.knownMiss === true && ids.length === 0 };
  });
  console.table(results);
  expect(results.filter((result) => !result.correct && !result.toleratedMiss)).toEqual([]);
});

it("does not classify modal count guidance as telemetry when evidence matches", () => {
  const retriever = createRunbookRetriever([fixture("test.a", { title: "DLQ retry guidance", keywords: ["retries"] })]);
  expect(retriever.retrieve({ query: finalEvaluation[4].query, ...options })).toHaveLength(1);
});

function fixture(chunkId: string, overrides: Partial<RunbookChunk> = {}): RunbookChunk {
  return {
    documentId: "test", version: "1", chunkId, title: "Test runbook",
    section: "Backlog", text: "Backlog recovery. Preserve warnings.", ...overrides,
  };
}

describe("keyword ranking and source metadata", () => {
  it("returns identical rankings across calls and corpus input order", () => {
    const request = { query: "Lambda throttling SQS backlog", ...options };
    const expected = runbookRetriever.retrieve(request);
    expect(expected.length).toBeGreaterThan(0);
    expect(runbookRetriever.retrieve(request)).toEqual(expected);
    expect(createRunbookRetriever([...runbookCorpus].reverse()).retrieve(request)).toEqual(expected);
  });

  it("breaks equal scores using stable chunk IDs", () => {
    const retriever = createRunbookRetriever([fixture("test.z"), fixture("test.a"), fixture("test.m")]);
    expect(retriever.retrieve({ query: "backlog", ...options }).map((c) => c.chunkId))
      .toEqual(["test.a", "test.m", "test.z"]);
  });

  it("ranks keywords above section matches and section matches above text/title matches", () => {
    const retriever = createRunbookRetriever([
      fixture("test.a-text", { section: "Backlog", text: "Backlog recovery" }),
      fixture("test.b-section", { section: "Backlog recovery" }),
      fixture("test.c-keyword", { keywords: ["recovery"] }),
    ]);
    expect(retriever.retrieve({ query: "backlog recovery", ...options }).map((c) => c.chunkId))
      .toEqual(["test.c-keyword", "test.b-section", "test.a-text"]);
  });

  it("uses document text when a section provides a relevant anchor", () => {
    const retriever = createRunbookRetriever([
      fixture("test.a", { text: "Backlog recovery includes worker capacity." }),
      fixture("test.b", { text: "Backlog recovery includes producer capacity." }),
    ]);
    expect(retriever.retrieve({ query: "backlog worker capacity", ...options }).map((c) => c.chunkId))
      .toEqual(["test.a", "test.b"]);
  });

  it("normalizes case, punctuation, whitespace, and repeated terms", () => {
    const expected = runbookRetriever.retrieve({ query: "sqs visibility timeout", ...options });
    expect(runbookRetriever.retrieve({ query: "  SQS: VISIBILITY-TIMEOUT!!! visibility  ", ...options }))
      .toEqual(expected);
  });

  it.each([
    ["ApproximateAgeOfOldestMessage", "sqs-backlog.metrics"],
    ["VisibilityTimeout", "sqs-backlog.visibility"],
    ["ReportBatchItemFailures", "lambda-failures.batch"],
    ["ConcurrentExecutions", "lambda-failures.throttling"],
    ["maxReceiveCount", "retry-dlq.policy"],
    ["StartMessageMoveTask", "retry-dlq.redrive"],
    ["dead-letter queue", "retry-dlq.policy"],
    ["Lambda throttling", "lambda-failures.throttling"],
  ])("matches identifier or alias %s", (query, expected) => {
    expect(runbookRetriever.retrieve({ query, ...options })[0]?.chunkId).toBe(expected);
  });

  it.each(["", " \n\t", "!!!", "how do I", "SQS", "Lambda DLQ", "gardening tomatoes",
    "prefixApproximateAgeOfOldestMessageSuffix", "constructor prototype __proto__"])(
    "returns a valid no-match for %j", (query) => {
      expect(runbookRetriever.retrieve({ query, ...options })).toEqual([]);
    },
  );

  it.each(["now", "current", "currently", "latest", "today", "live", "real-time"])(
    "abstains from %s operational data", (time) => {
      expect(runbookRetriever.retrieve({ query: `Lambda error rate ${time}`, ...options })).toEqual([]);
    },
  );

  it("preserves all source metadata and whole evidence text", () => {
    const chunk = runbookRetriever.retrieve({ query: "maxReceiveCount", ...options })[0];
    expect(chunk).toEqual(runbookCorpus.find((c) => c.chunkId === "retry-dlq.policy"));
    expect(chunk).toMatchObject({
      documentId: "retry-dlq", version: "1", chunkId: "retry-dlq.policy",
      title: "Retry and DLQ Recovery", section: "Redrive policy and poison message isolation",
    });
    expect(Object.isFrozen(chunk)).toBe(true);
    expect(Object.isFrozen(chunk.keywords)).toBe(true);
  });

  it("snapshots source data and keeps result arrays and budgets local to each call", () => {
    const keywords = ["replay"];
    const source = { ...fixture("test.a"), keywords };
    const corpus = [source];
    const retriever = createRunbookRetriever(corpus);
    source.text = "changed";
    keywords[0] = "changed";
    corpus.length = 0;
    const request = { query: "replay", ...options };
    const first = retriever.retrieve(request);
    expect(first[0].text).toBe("Backlog recovery. Preserve warnings.");
    expect(first[0].keywords).toEqual(["replay"]);
    (first as RunbookChunk[]).length = 0;
    expect(retriever.retrieve({ ...request, maxEvidenceChars: 1 })).toEqual([]);
    expect(retriever.retrieve(request)).toHaveLength(1);
  });
});

describe("retrieval limits and invalid requests", () => {
  const retriever = createRunbookRetriever([
    fixture("test.a", { text: "Backlog: keep this complete recovery warning." }),
    fixture("test.b", { text: "Backlog." }),
    fixture("test.c", { text: "Backlog: safe." }),
  ]);
  const request = { query: "backlog", ...options };

  it.each([0, 1, 2, 3, 20])("enforces a maximum of %i chunks", (maxChunks) => {
    expect(retriever.retrieve({ ...request, maxChunks })).toHaveLength(Math.min(maxChunks, 3));
  });

  it("accepts an exact character boundary without truncating the warning", () => {
    const text = "Backlog: keep this complete recovery warning.";
    expect(retriever.retrieve({ ...request, maxEvidenceChars: text.length }).map((c) => c.text)).toEqual([text]);
  });

  it("skips an oversized chunk and keeps smaller qualifying chunks in ranked order", () => {
    const selected = retriever.retrieve({ ...request, maxEvidenceChars: 22 });
    expect(selected.map((c) => c.chunkId)).toEqual(["test.b", "test.c"]);
    expect(selected.reduce((sum, c) => sum + c.text.length, 0)).toBe(22);
  });

  it.each([0, 1, 7])("returns empty if no whole chunk fits %i characters", (maxEvidenceChars) => {
    expect(retriever.retrieve({ ...request, maxEvidenceChars })).toEqual([]);
  });

  it("counts UTF-16 code units consistently with JavaScript string.length", () => {
    const unicode = createRunbookRetriever([fixture("test.a", { text: "😀" })]);
    expect(unicode.retrieve({ ...request, maxEvidenceChars: 1 })).toEqual([]);
    expect(unicode.retrieve({ ...request, maxEvidenceChars: 2 })[0].text).toBe("😀");
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "3", null, undefined])(
    "rejects invalid limits %j rather than treating them as no-match", (value) => {
      for (const field of ["maxChunks", "maxEvidenceChars"] as const) {
        expect(() => retriever.retrieve({ ...request, [field]: value } as never)).toThrow(RangeError);
      }
    },
  );

  it.each([null, undefined, 12, {}, "x".repeat(8001)])("rejects invalid query %j", (query) => {
    expect(() => retriever.retrieve({ ...request, query } as never)).toThrow(TypeError);
  });

  it("accepts the maximum query length and rejects a missing request", () => {
    expect(() => retriever.retrieve({ ...request, query: "x".repeat(8000) })).not.toThrow();
    expect(() => retriever.retrieve(null as never)).toThrow(TypeError);
  });
});

describe("corpus validation", () => {
  it("contains three versioned documents and at most eighteen unique chunks", () => {
    expect(new Set(runbookCorpus.map((c) => c.documentId)).size).toBe(3);
    expect(runbookCorpus.length).toBeLessThanOrEqual(18);
    expect(new Set(runbookCorpus.map((c) => c.chunkId)).size).toBe(runbookCorpus.length);
    expect(() => createRunbookRetriever(runbookCorpus)).not.toThrow();
  });

  it.each([null, undefined, {}, [], [null], ["invalid"]])("rejects invalid corpus %j", (corpus) => {
    expect(() => createRunbookRetriever(corpus as never)).toThrow(InvalidRunbookCorpusError);
  });

  it.each(["documentId", "version", "chunkId", "title", "section", "text"] as const)(
    "requires nonempty string %s", (field) => {
      for (const value of [undefined, null, 12, "", "  "]) {
        expect(() => createRunbookRetriever([{ ...fixture("test.a"), [field]: value }] as never))
          .toThrow(InvalidRunbookCorpusError);
      }
    },
  );

  it("rejects duplicate or unstable IDs and inconsistent document metadata", () => {
    for (const corpus of [
      [fixture("test.a"), fixture("test.a")],
      [fixture("other.a")], [fixture("test.a b")], [fixture("test.a", { documentId: "Test" })],
      [fixture("test.a"), fixture("test.b", { version: "2" })],
      [fixture("test.a"), fixture("test.b", { title: "Another title" })],
    ]) {
      expect(() => createRunbookRetriever(corpus)).toThrow(InvalidRunbookCorpusError);
    }
  });

  it.each([null, "backlog", [""], ["  "], ["!!!"], [12]])("rejects invalid keywords %j", (keywords) => {
    expect(() => createRunbookRetriever([{ ...fixture("test.a"), keywords }] as never))
      .toThrow(InvalidRunbookCorpusError);
  });

  it("permits omitted or empty optional keywords", () => {
    expect(() => createRunbookRetriever([fixture("test.a"), fixture("test.b", { keywords: [] })]))
      .not.toThrow();
  });
});
