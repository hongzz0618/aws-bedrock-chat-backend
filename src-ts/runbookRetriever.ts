import { runbookCorpus, type RunbookChunk } from "./runbookCorpus";

export interface RunbookRetrievalRequest {
  readonly query: string;
  readonly maxChunks: number;
  /** Sum of selected text.length values (UTF-16 code units), excluding metadata. */
  readonly maxEvidenceChars: number;
}

export interface RunbookRetriever {
  retrieve(request: RunbookRetrievalRequest): readonly RunbookChunk[];
}

export class InvalidRunbookCorpusError extends Error {
  constructor() {
    super("Invalid runbook corpus");
    this.name = "InvalidRunbookCorpusError";
  }
}

const MAX_QUERY_CHARS = 8000;
const stopWords = new Set((
  "a an the and or of to in on for from with by as at is are was were be been being " +
  "do does did how what why when where which who should would could can may must " +
  "i my we our you your it its this that these those there then than if after before " +
  "while during so but into out up again still only too not no have has had will " +
  "check investigate diagnose explain help mean relate set configure fix repair resolve"
).split(" "));
// Topic words contribute to ranking, but cannot establish relevant evidence alone.
const topicWords = new Set("aws amazon sqs lambda dlq queue message function request record".split(" "));
const variants = new Map([
  ["throttling", "throttle"], ["throttled", "throttle"], ["throttles", "throttle"],
  ["retries", "retry"], ["retried", "retry"], ["retrying", "retry"],
  ["failed", "failure"], ["failing", "failure"], ["failures", "failure"],
]);

function tokens(value: string): string[] {
  return (value.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((token) => !stopWords.has(token))
    .map((token) => variants.get(token) ?? (token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token));
}

function requestsTelemetry(query: string): boolean {
  const time = /\b(now|current|currently|latest|today|live|real[ -]time)\b/i;
  const guidance = /\b(how (?:do|can|should|to)|what should|why|troubleshoot|diagnose|investigate)\b/i;
  // Explicit measurements take precedence, including mixed guidance/status requests.
  const measurement = /\bhow many\b|\b(?:show|fetch|read|get|tell me)\b[^?!.;]*\b(?:my|account|production|current|live|latest)\b|\b(?:what is|what's)\b[^?!.;]*\b(?:current|live|latest)\b/i;
  return measurement.test(query) || (time.test(query) && !guidance.test(query));
}

function validateCorpus(corpus: readonly RunbookChunk[]): void {
  if (!Array.isArray(corpus) || corpus.length === 0) throw new InvalidRunbookCorpusError();
  const ids = new Set<string>();
  const documents = new Map<string, { version: string; title: string }>();
  for (const chunk of corpus) {
    if (!chunk || typeof chunk !== "object") throw new InvalidRunbookCorpusError();
    for (const field of ["documentId", "version", "chunkId", "title", "section", "text"] as const) {
      if (typeof chunk[field] !== "string" || !chunk[field].trim()) throw new InvalidRunbookCorpusError();
    }
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(chunk.documentId) ||
        !chunk.chunkId.startsWith(`${chunk.documentId}.`) ||
        !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(chunk.chunkId) || ids.has(chunk.chunkId)) {
      throw new InvalidRunbookCorpusError();
    }
    if (chunk.keywords !== undefined && (!Array.isArray(chunk.keywords) ||
        chunk.keywords.some((keyword: unknown) => typeof keyword !== "string" || tokens(keyword).length === 0))) {
      throw new InvalidRunbookCorpusError();
    }
    const document = documents.get(chunk.documentId);
    if (document && (document.version !== chunk.version || document.title !== chunk.title)) {
      throw new InvalidRunbookCorpusError();
    }
    documents.set(chunk.documentId, { version: chunk.version, title: chunk.title });
    ids.add(chunk.chunkId);
  }
}

/** Validate once and snapshot the corpus so callers cannot mutate the index. */
export function createRunbookRetriever(corpus: readonly RunbookChunk[]): RunbookRetriever {
  validateCorpus(corpus);
  const index = corpus.map((source) => {
    const chunk: RunbookChunk = Object.freeze({
      documentId: source.documentId, version: source.version, chunkId: source.chunkId,
      title: source.title, section: source.section, text: source.text,
      ...(source.keywords ? { keywords: Object.freeze([...source.keywords]) } : {}),
    });
    const weights = new Map<string, number>();
    for (const [value, weight] of [
      [chunk.title, 1], [chunk.text, 1], [chunk.section, 4], [(chunk.keywords ?? []).join(" "), 5],
    ] as const) {
      for (const token of tokens(value)) weights.set(token, Math.max(weights.get(token) ?? 0, weight));
    }
    return { chunk, weights, keywords: (chunk.keywords ?? []).map(tokens) };
  });

  return Object.freeze({
    retrieve(request: RunbookRetrievalRequest): readonly RunbookChunk[] {
      if (!request || typeof request.query !== "string" || request.query.length > MAX_QUERY_CHARS) {
        throw new TypeError("Invalid runbook query");
      }
      if (!Number.isSafeInteger(request.maxChunks) || request.maxChunks < 0 ||
          !Number.isSafeInteger(request.maxEvidenceChars) || request.maxEvidenceChars < 0) {
        throw new RangeError("Invalid runbook retrieval limits");
      }
      // Guidance can mention "now" without requesting live measurements.
      // This heuristic is not a grounding boundary for future chat integration.
      if (requestsTelemetry(request.query)) return [];
      const queueContext = /\b(sqs|queues?|messages?)\b/i.test(request.query);
      const normalized = queueContext
        ? request.query.replace(/\b(growing|accumulating)\b/gi, "backlog")
        : request.query;
      const query = [...new Set(tokens(normalized))];
      const subjects = query.filter((token) => ["sqs", "lambda", "dlq", "queue", "function"].includes(token));
      const specific = query.filter((token) => !topicWords.has(token));
      if (specific.length === 0 || request.maxChunks === 0 || request.maxEvidenceChars === 0) return [];

      const ranked = index.flatMap(({ chunk, weights, keywords }) => {
        // Coverage remains useful for broad matches. A complete curated keyword
        // plus a matching subject also qualifies, allowing conversational filler
        // and multiple symptoms without requiring one chunk to cover them all.
        const matched = specific.filter((token) => weights.has(token));
        const keywordMatch = subjects.some((token) => weights.has(token)) && keywords.some((keyword) =>
          keyword.some((token) => !topicWords.has(token)) && keyword.every((token) => query.includes(token)));
        const covered = matched.length / specific.length >= 0.6 &&
          matched.some((token) => (weights.get(token) ?? 0) >= 4);
        if (!keywordMatch && !covered) return [];
        const score = query.reduce((sum, token) => sum + (weights.get(token) ?? 0), 0);
        return [{ chunk, score }];
      }).sort((a, b) => b.score - a.score ||
        (a.chunk.chunkId < b.chunk.chunkId ? -1 : a.chunk.chunkId > b.chunk.chunkId ? 1 : 0));

      let remaining = request.maxEvidenceChars;
      const selected: RunbookChunk[] = [];
      for (const { chunk } of ranked) {
        // Never cut off prerequisites or warnings. Skip oversized chunks and
        // continue to the next qualifying whole chunk, preserving ranked order.
        if (chunk.text.length > remaining) continue;
        selected.push(chunk);
        remaining -= chunk.text.length;
        if (selected.length === request.maxChunks) break;
      }
      return selected;
    },
  });
}

// Reused across warm Lambda invocations when imported by a future integration.
export const runbookRetriever: RunbookRetriever = createRunbookRetriever(runbookCorpus);
