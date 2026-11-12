import { buildRunbookContext, RUNBOOK_ABSTENTION, RUNBOOK_LIMITS } from "../dist/runbookContext.js";
import { runbookRetriever } from "../dist/runbookRetriever.js";

const question = process.argv.slice(2).join(" ").trim();
const questions = question ? [question] : [
  "What does maxReceiveCount do in an SQS redrive policy?",
  "How many Lambda Errors occurred in production today?",
];

for (const query of questions) {
  const chunks = runbookRetriever.retrieve({ query, ...RUNBOOK_LIMITS });
  const { sources } = buildRunbookContext(query, chunks);
  const evidence = chunks.filter((chunk) => sources.some((source) => source.chunkId === chunk.chunkId));
  console.log(JSON.stringify({
    question: query,
    sources,
    excerpts: evidence.map(({ chunkId, text }) => ({ chunkId, text })),
    ...(sources.length === 0 ? { abstention: RUNBOOK_ABSTENTION } : {}),
  }, null, 2));
}
