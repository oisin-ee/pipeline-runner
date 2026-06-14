---
id: PIPE-82.1
title: Add js-tiktoken token-estimation primitive (src/token-estimator.ts)
status: To Do
assignee: []
created_date: '2026-06-14 22:35'
labels:
  - token-engineering
dependencies: []
references:
  - /Users/oisin/.claude/plans/federated-sparking-truffle.md
  - src/model-resolver.ts
modified_files:
  - package.json
  - bun.lock
  - src/token-estimator.ts
  - tests/token-estimator.test.ts
parent_task_id: PIPE-82
priority: high
ordinal: 211000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Provide the single estimateTokens(text) primitive the scheduler/runtime use to size node context. Foundational dependency for size-aware model selection (PIPE-82.* model selection) and the hard context cap.

SEAM: new top-level util mirroring src/model-resolver.ts shape. Use js-tiktoken with the o200k_base encoding (the gpt-5.5 family the MoKa agents run on). Lazy-init the encoder once at module scope. Document in a comment that it is a cross-model ESTIMATE (pipeline routes across OpenAI/Kimi/Qwen); Anthropic-runner exactness would use the count_tokens API. Library vetted via ecosyste.ms (MIT, 2,468 dependent repos, 0 advisories). Add with `bun add js-tiktoken` (updates package.json + bun.lock; do not hand-edit the lock).

LIBRARY: adopt js-tiktoken (do NOT hand-roll chars/4). QUALITY: no casts/suppressions; single-responsibility module.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 js-tiktoken is a dependency in package.json and bun.lock (added via bun add)
- [ ] #2 src/token-estimator.ts exports estimateTokens(text: string): number using the o200k_base encoder initialized once at module scope, with a comment documenting the cross-model-estimate caveat
- [ ] #3 tests/token-estimator.test.ts asserts: empty string -> 0; a longer string returns strictly more than a shorter one; a fixed known string returns a count within an asserted band
- [ ] #4 npx vitest run tests/token-estimator.test.ts passes and npx tsc --noEmit is clean
<!-- AC:END -->
