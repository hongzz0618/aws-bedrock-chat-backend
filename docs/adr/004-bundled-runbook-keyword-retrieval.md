# ADR 004 — Bundled keyword retrieval for Runbooks

## Context

Runbook mode starts with three curated English documents. Troubleshooting questions often contain AWS metric names or service terms that can be matched directly. The project needs reproducible retrieval and clear evidence when no suitable guidance exists.

## Decision

Version Markdown in Git and regenerate the checked-in corpus when the Runbooks change. Bundle it in Lambda and rank excerpts with the shared tokenizer and keyword rules. Keep source IDs stable and pass whole, size-bounded excerpts to Converse. Return their metadata as structured sources. If no evidence fits, return a fixed abstention and skip the model call.

## Consequences

The corpus is reviewable with the application change and retrieval can be evaluated offline. The approach avoids embedding generation, an index service and runtime document fetches. It works with the current corpus size and the explicit terminology in the Runbooks. Semantic retrieval could improve recall for unfamiliar paraphrases, but would introduce another retrieval dependency, additional evaluation work and operating cost.

Corpus updates require a rebuild and deployment. Keyword matching can miss relevant guidance or retrieve related material that does not support a claim. The supplied source IDs make the request traceable. Assess answer claims and adversarial cases with the separate [live evaluation rubric](../rag-phase1-evaluation.md#future-approved-live-evaluation--not-tested). Revisit retrieval if corpus growth or recurring paraphrase misses justify measuring another approach.
