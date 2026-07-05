---
id: PIPE-83.7
title: >-
  Generate N candidate implementations via kind: parallel, budget-gated (default
  N=1)
status: Done
assignee: []
created_date: "2026-06-15 17:34"
updated_date: "2026-06-16 08:28"
labels:
  - architecture
  - config
dependencies:
  - PIPE-83.1
  - PIPE-83.4
parent_task_id: PIPE-83
priority: medium
ordinal: 225000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workstream B. Express green-implementation as a kind: parallel of N children in pipeline.yaml, each in its own worktree (PIPE-83.4) and each emitting a NodeHandoff (PIPE-83.1). Width-capped by the existing fan_out_width caps. N defaults to 1 (byte-identical to today) and only grows when token_budget allows.

CONFIG-FIRST: this is catalog YAML + a budget gate; no bespoke module. These candidates feed the selector in PIPE-83.9.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 green-implementation can fan out to N worktree-isolated candidates, each producing a diff + NodeHandoff
- [x] #2 N defaults to 1 and is byte-identical to current behaviour at N=1
- [x] #3 N is raised only when token_budget allows; fan-out respects existing per-category caps
- [x] #4 A 2-candidate run completes with two independent diffs ready for selection
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

AC3 CORRECTION (recon finding): candidate COUNT (N) is config-gated, but per-category fan_out_width caps are NOT enforced on kind:parallel CHILDREN at runtime — executeParallelChildren respects only context.maxParallelNodes, not token_budget.fan_out_width.by_category (src/runtime/parallel-node/parallel-node.ts). So N candidates run up to maxParallelNodes concurrently, not throttled to the green cap. FOLLOW-UP: make executeParallelChildren cap child concurrency by child category using FanOutWidth semantics (the existing claimCategorySlot logic from the top-level scheduler). Generation + isolation (83.4) are in place; runtime per-category throttling inside parallel nodes is the remaining gap for true budget-respecting fan-out.

AC3 NOW MET (commit af2fdae, pushed to main): parallel-node children are throttled by their category's token_budget.fan_out_width cap (childCategory id-match + per-category p-limit gate, under the global maxParallelNodes). N best-of-N green candidates now respect green=2. Children matching no configured category, or running without token_budget, pass through unchanged (full suite 610 green). Closes the runtime gap the recon flagged.

<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Committed b498e3e (controller-implemented). New deterministic schedule pass src/schedule/passes/candidates.ts (expandBestOfNCandidates), wired into the pass pipeline as coverage -> candidates -> models -> ids -> references (SCHEDULE_PASS_ORDER + assertSchedulePassOrder + schedule-planner-boundaries contract test all updated). Gated by a new config flag best_of_n { enabled (default false), n (default 1), categories (default ["green"]) }: when enabled with n>1, each agent node whose id carries a configured category is expanded into a kind:parallel of N candidate children (full copies, fresh ids `<id>--c<i>`, needs:[]); the parallel wrapper keeps the original id + upstream needs so downstream + the PIPE-83.9 selector see one dependency. Pairs with PIPE-83.4 worktree isolation (each candidate builds in its own tree) and PIPE-83.1 handoffs. Default off / n=1 is identity -> generated schedules + PIPE-57 goldens unchanged. Tests: identity (absent/disabled/n=1) + 2-candidate expansion leaving non-matching nodes. Verified: tsc clean, ultracite clean, fallow-audit 0 introduced findings (1 non-blocking duplication warn matching the existing pass idiom), full suite 604 passed / 4 skipped. NEXT (PIPE-83.9): the select-candidate builtin that runs each candidate's tests + LLM judge and picks, inserted between the parallel wrapper and the consumer.

<!-- SECTION:FINAL_SUMMARY:END -->
