---
id: PIPE-45.11
title: Split agent-node execution surface
status: Done
assignee: []
created_date: '2026-06-27 14:03'
labels: []
dependencies:
  - PIPE-45.4
references:
  - src/runtime/agent-node/agent-node.ts
modified_files:
  - src/runtime/agent-node/agent-node.ts
  - src/runtime/agent-node/handoff-finalization.ts
  - src/runtime/agent-node/model-selection.ts
  - src/runtime/agent-node/output-finalization.ts
  - src/runtime/agent-node/prompt-rendering.ts
  - src/runtime/agent-node/session-execution.ts
  - src/runtime/agent-node/agent-node.test.ts
  - tests/agent-node-refactor-boundaries.test.ts
parent_task_id: PIPE-45
priority: high
ordinal: 306000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: Split src/runtime/agent-node/agent-node.ts into prompt/context preparation, host process/session execution, result parsing, event emission, and retry/error policy.
Dependencies: PIPE-45.4
Likely modified files: src/runtime/agent-node/agent-node.ts, src/runtime/agent-node/*, tests/runtime-actor-*.test.ts
Reuse: @opencode-ai/sdk and existing runner/session abstractions; no subprocess scraping rewrite unless already ticketed separately.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Agent-node execution concerns have named modules with one owner each -- Evidence: source inspection: `src/runtime/agent-node/agent-node.ts` now owns execution flow only; prompt/context rendering moved to `prompt-rendering.ts`; model choice moved to `model-selection.ts`; runner/session launch and event/session-id recording moved to `session-execution.ts`; structured output normalization/repair moved to `output-finalization.ts`; context handoff derivation moved to `handoff-finalization.ts`. No alias/facade/compat layer was added.
- [x] #2 Agent-node public/runtime behaviour remains stable -- Evidence: `bun run test tests/agent-node-refactor-boundaries.test.ts src/runtime/agent-node/agent-node.test.ts tests/runtime-actor-contract-boundary.test.ts tests/pipeline-runtime.test.ts` passed, 4 files / 86 tests; `bun run test` passed, 150 files / 1099 tests, with 5 files / 41 tests skipped by existing suite conditions.
- [x] #3 src/runtime/agent-node/agent-node.ts falls below 1k lines or records structural justification -- Evidence: `wc -l src/runtime/agent-node/agent-node.ts ...` reports `src/runtime/agent-node/agent-node.ts` at 213 lines; `pnpm exec fallow audit --changed-since HEAD --production` passed with no changed-file issues.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Run feature-implementation workflow in order and record proof.
<!-- DOD:END -->

## Evidence

- RED boundary proof: `bun run test tests/agent-node-refactor-boundaries.test.ts` failed before owner modules existed.
- Focused proof: `bun run test tests/agent-node-refactor-boundaries.test.ts src/runtime/agent-node/agent-node.test.ts tests/runtime-actor-contract-boundary.test.ts tests/pipeline-runtime.test.ts` passed, 86 tests.
- Static proof: `bun run typecheck` passed.
- Lint/format proof: `bun run check` passed.
- Complexity proof: `pnpm exec fallow audit --changed-since HEAD --production` passed with no issues in 8 changed files.
- Build proof: `bun run build` passed.
- Security dependency proof: `pnpm audit --audit-level high` exited 0; reported 1 low and 2 moderate vulnerabilities.
- Whitespace proof: `git diff --check` passed.
- Full regression proof: `bun run test` passed, 1099 tests; 41 existing conditional skips.
