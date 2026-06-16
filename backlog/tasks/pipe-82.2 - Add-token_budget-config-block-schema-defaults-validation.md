---
id: PIPE-82.2
title: 'Add token_budget config block (schema, defaults, validation)'
status: Done
assignee: []
created_date: '2026-06-14 22:35'
updated_date: '2026-06-14 23:26'
labels:
  - token-engineering
  - config
dependencies: []
references:
  - /Users/oisin/.claude/plans/federated-sparking-truffle.md
  - src/config/schemas.ts
  - src/config/validate.ts
  - src/config/load.ts
modified_files:
  - src/config/schemas.ts
  - src/config/validate.ts
  - src/config/load.ts
  - defaults/pipeline.yaml
  - .pipeline/pipeline.yaml
  - tests/config.test.ts
parent_task_id: PIPE-82
priority: high
ordinal: 212000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Introduce the config home for every token-aware threshold so the rules are config-first. This is the SHARED CONTRACT the model-selection, fan-out, and planner tickets depend on — build it first.

SEAM: add tokenBudgetSchema in src/config/schemas.ts (.strict(), optional fields with .default()), wired into pipelineFileSchema and surfaced onto PipelineConfig through parsePipelineConfigParts in src/config/load.ts (mirror how `scheduler`/`schedules` flow through). Cross-field validation goes in src/config/validate.ts (reuse the validateRegistryIds / reference patterns). Block shape:
  token_budget:
    default_context_window: 200000   # window assumed for unknown models
    max_context_pct: 50              # hard cap: node context <= pct% of window
    model_context_windows: { <model-id>: <int> }   # optional overrides
    fan_out_width: { default: 4, by_category: { green: 2 } }
Add the block to BOTH defaults/pipeline.yaml (authoritative) and .pipeline/pipeline.yaml (mirror) with the defaults above.

CONFIG-FIRST: thresholds live in YAML, not code. QUALITY: no casts; strict schema; clear validation error messages.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 tokenBudgetSchema (.strict, optional fields with defaults) is added in src/config/schemas.ts, wired into pipelineFileSchema, and surfaced on PipelineConfig via parsePipelineConfigParts in src/config/load.ts
- [ ] #2 defaults/pipeline.yaml and .pipeline/pipeline.yaml both carry a token_budget block with default_context_window 200000, max_context_pct 50, fan_out_width.default 4, fan_out_width.by_category.green 2
- [ ] #3 src/config/validate.ts rejects max_context_pct outside (0,100], non-positive model_context_windows values, and by_category keys that are not declared node categories, each with a clear message
- [ ] #4 tests/config.test.ts asserts: block parses; omitted block yields the documented defaults; invalid pct and negative window are rejected with the expected error
- [ ] #5 npx vitest run tests/config.test.ts passes and npx tsc --noEmit is clean
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added token_budget config block (schema + validation + defaults in both pipeline.yamls). Live: `moka validate` and `moka doctor` pass on 2.4.0 with the block; bundled defaults ship it. Tests assert defaults/parse/reject.
<!-- SECTION:FINAL_SUMMARY:END -->
