---
id: PIPE-82.6
title: Make the schedule-planner prompt token-aware
status: Done
assignee: []
created_date: '2026-06-14 22:36'
updated_date: '2026-06-14 23:26'
labels:
  - token-engineering
  - scheduler
dependencies:
  - PIPE-82.2
references:
  - /Users/oisin/.claude/plans/federated-sparking-truffle.md
  - src/schedule/prompts.ts
  - tests/schedule-planner.test.ts
modified_files:
  - src/schedule/prompts.ts
  - tests/schedule-planner.test.ts
parent_task_id: PIPE-82
priority: medium
ordinal: 216000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Inject the budget rules into the planner prompt so generated schedules order model fallbacks and shape parallelism within the caps up front (not just at runtime). The user explicitly wants the scheduler to take token budget into account.

DEPENDS ON PIPE-82.2 (provides token_budget on PipelineConfig).

SEAM: src/schedule/prompts.ts — plannerPrompt() / schedulerCatalogPrompt(). Add lines listing max_context_pct, the per-category fan_out_width caps, and any known model_context_windows, with the instruction: "prefer the smallest-tier model whose context window comfortably holds the node within the cap; do not exceed the category fan-out width." Pull values from config.token_budget.

QUALITY: prompt text only; no behavioural casts. Keep the existing catalog/profile sections intact.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 plannerPrompt/schedulerCatalogPrompt (src/schedule/prompts.ts) emit max_context_pct, per-category fan_out_width caps, and known model_context_windows, plus the smallest-fitting-model + fan-out instruction, sourced from config.token_budget
- [ ] #2 When token_budget is absent the prompt is unchanged from current behaviour
- [ ] #3 tests/schedule-planner.test.ts (or a prompt-focused test) asserts the generated prompt contains the cap and fan-out lines
- [ ] #4 npx vitest run (planner prompt test) passes and npx tsc --noEmit is clean
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
plannerPrompt is token-aware (emits max_context_pct, model windows, per-category fan-out caps + smallest-fitting-model instruction). Asserted via a plannerPrompt test.
<!-- SECTION:FINAL_SUMMARY:END -->
