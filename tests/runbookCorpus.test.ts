import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateCorpus, loadRunbooks } from "../scripts/generate_runbook_corpus.mjs";
import { runbookCorpus } from "../src-ts/runbookCorpus";

const fixture = `---
documentId: test
version: "1"
---

# Test Runbook

## Inspect failure counts
<!--
chunkId: test.errors
keywords: ["failure counts"]
-->

Compare counts across the same time window.
`;

it("preserves all original documents and chunk IDs and compiles the Markdown contents", () => {
  expect(runbookCorpus.map(({ chunkId }) => chunkId)).toEqual([
    "sqs-backlog.metrics", "sqs-backlog.consumers", "sqs-backlog.visibility", "sqs-backlog.inflight",
    "lambda-failures.errors", "lambda-failures.throttling", "lambda-failures.duration", "lambda-failures.batch",
    "retry-dlq.policy", "retry-dlq.redrive", "retry-dlq.idempotency", "retry-dlq.backoff",
  ]);
  expect(new Set(runbookCorpus.map(({ documentId }) => documentId))).toEqual(
    new Set(["sqs-backlog", "lambda-failures", "retry-dlq"]),
  );
  expect(runbookCorpus).toEqual(loadRunbooks());
});

it("reproduces the checked-in TypeScript corpus", () => {
  const checkedIn = readFileSync(new URL("../src-ts/runbookCorpus.ts", import.meta.url), "utf8")
    .replaceAll("\r\n", "\n");
  const generated = generateCorpus();
  expect(generated).toBe(generateCorpus());
  expect(generated, "Run npm run runbooks:generate after editing a Runbook").toBe(checkedIn);
});

describe("Runbook source validation", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "runbooks-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("generates identical TypeScript from LF and CRLF sources", () => {
    const source = join(directory, "test.md");
    writeFileSync(source, fixture);
    const generated = generateCorpus(directory);
    writeFileSync(source, fixture.replaceAll("\n", "\r\n"));
    expect(generateCorpus(directory)).toBe(generated);
  });

  it("rejects repeated document IDs across files", () => {
    writeFileSync(join(directory, "01-test.md"), fixture);
    writeFileSync(join(directory, "02-test.md"), fixture);
    expect(() => generateCorpus(directory)).toThrow('02-test.md: duplicate documentId "test"');
  });

  it("rejects repeated chunk IDs within a document", () => {
    const section = fixture.slice(fixture.indexOf("## "));
    writeFileSync(join(directory, "test.md"), fixture + "\n" + section);
    expect(() => generateCorpus(directory)).toThrow('test.md (section 2): duplicate chunkId "test.errors"');
  });

  it.each([
    ["documentId: test", "documentId: Test", "test.md: invalid documentId"],
    ['version: "1"', "version: 1", "test.md: version must be a quoted positive integer"],
    ['version: "1"', 'version: "1"\nversion: "2"', "test.md: invalid YAML metadata"],
    ['version: "1"\n', "", "test.md: expected metadata fields documentId, version"],
    ["chunkId: test.errors", "chunkId: other.errors", 'test.md (section 1): chunkId must be a valid ID'],
    ['["failure counts"]', "[123]", "test.md (section 1): keywords must be a list"],
    ['["failure counts"]', '["failure counts", "How to CHECK!"]', "at least one searchable word each"],
    ["Compare counts across the same time window.", "", "test.md (section 1): expected a heading"],
  ])("rejects invalid source when %j is replaced with %j", (from, to, error) => {
    writeFileSync(join(directory, "test.md"), fixture.replace(from, to));
    expect(() => generateCorpus(directory)).toThrow(error);
  });
});
