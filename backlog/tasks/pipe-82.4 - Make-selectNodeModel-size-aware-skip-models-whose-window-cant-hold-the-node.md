---
id: PIPE-82.4
title: Make selectNodeModel size-aware (skip models whose window can't hold the node)
status: Done
assignee: []
created_date: "2026-06-14 22:36"
updated_date: "2026-06-14 23:26"
labels:
  - token-engineering
dependencies:
  - PIPE-82.2
references:
  - /Users/oisin/.claude/plans/federated-sparking-truffle.md
  - src/model-resolver.ts
  - tests/model-resolver.test.ts
modified_files:
  - src/model-resolver.ts
  - tests/model-resolver.test.ts
parent_task_id: PIPE-82
priority: high
ordinal: 214000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Route each node to the first fallback model whose context window can hold its estimated context within max_context_pct; if none fit, return no model with a clear reason so the caller (context-cap ticket) fails the node. Must stay backward-compatible.

DEPENDS ON PIPE-82.2 (provides token_budget: max_context_pct, default_context_window, model_context_windows on PipelineConfig).

SEAM: src/model-resolver.ts. Extend selectNodeModel(node, opts?) to accept { estimatedTokens, budget, contextWindowFor }. After the existing PIPELINE_DISABLED_MODELS filter, skip models where window < estimatedTokens / (max_context_pct/100); return first fit. Window lookup: budget.model_context_windows[id] ?? budget.default_context_window. None-fit -> { model: undefined, reason, skipped }. When opts is omitted, behaviour is byte-identical to today (the existing ModelSelection contract).

QUALITY: no casts/suppressions; pure function; reason strings are explicit.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 selectNodeModel accepts an optional opts { estimatedTokens, budget, contextWindowFor } and, after the disabled-models filter, skips models whose window < estimatedTokens / (max_context_pct/100), returning the first fit
- [ ] #2 When no fitting model exists, returns { model: undefined, reason includes the estimate and pct, skipped }
- [ ] #3 Calling selectNodeModel(node) with no opts is behaviourally identical to current main (covered by an explicit test)
- [ ] #4 tests/model-resolver.test.ts is extended to assert: too-small model skipped with reason, first-fit chosen, none-fit path, and the legacy no-opts path
- [ ] #5 npx vitest run tests/model-resolver.test.ts passes and npx tsc --noEmit is clean
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

selectNodeModel is size-aware (skips models whose window can't hold the node within the cap; none-fit → no model + reason). Backward-compatible. Live: drove the 308148-token over-budget run skipping openai/gpt-5.5.

<!-- SECTION:FINAL_SUMMARY:END -->
