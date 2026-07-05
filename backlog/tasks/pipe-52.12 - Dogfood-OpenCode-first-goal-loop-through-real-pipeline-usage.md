---
id: PIPE-52.12
title: Dogfood OpenCode-first goal loop through real pipeline usage
status: To Do
assignee: []
created_date: "2026-06-08 19:02"
updated_date: "2026-07-04 19:42"
labels:
  - verification
  - dogfood
  - opencode
dependencies:
  - PIPE-52.4
  - PIPE-52.5
  - PIPE-52.6
  - PIPE-52.7
  - PIPE-52.9
  - PIPE-52.10
  - PIPE-52.11
references:
  - AGENTS.md
  - package.json
  - tests/dogfood-installed.test.ts
modified_files:
  - tests/dogfood-installed.test.ts
  - tests/dogfood-live-runners.test.ts
parent_task_id: PIPE-52
priority: high
ordinal: 157000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Verify the complete OpenCode-first goal-loop system through real repository usage paths, not isolated scripts.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 Run package checks: bun run typecheck, bun run check, bun run test, and bun run build.
- [ ] #2 Run real generated-host checks: pipe install-commands --host opencode --check and pipe validate.
- [ ] #3 Generate and inspect at least one scheduled pipe artifact and one team-graph schedule artifact, then run validate and explain-plan on both.
- [ ] #4 Run a built or dogfood-installed OpenCode workflow that exercises goal-state persistence, a verifier failure or acceptance failure continuation, and a final PASS or explicit blocked outcome.
- [ ] #5 If Kubernetes runner-job path is in scope for the implementation branch, run the real runner-job manifest/product path with orchestrator opencode and report event evidence; do not use ad hoc cluster probes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

This is the final integration gate. Use the repository Verification Standard: real CLI, generated command surfaces, installed/dogfood flow, build, and representative end-to-end path. Report exact commands and what they proved.

<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

Groomed 2026-07-04. VERDICT: GROOM — valid, un-started, keep To Do. Sole remaining child of epic PIPE-52. All dependency subtasks (52.4–52.11) are Done. Goal-loop implementation confirmed present: src/runtime/goal-loop/{goal-loop.ts,continuation-prompt.ts}, src/runtime/goal-state/{goal-state.ts,goal-requirement.ts}, src/runtime/services/goal-loop-service.ts.

AC COMMAND DRIFT — the ACs predate the toolchain + CLI rename; correct before executing:

- AC#1: `bun run typecheck/check/test/build` → toolchain is now `nub` + vitest + ultracite. Use: `nub run typecheck` (tsc --noEmit), `nub run check` (= ultracite check), `nub run test` (= vitest run), `nub run build` (= tsdown).
- AC#2: `pipe install-commands --host opencode --check` and `pipe validate` → the CLI binary is now `moka` (package @oisincoveney/pipeline, bin `moka`). install-commands is folded into `moka init` (see src/pipeline-init.ts importing installCommands; recent commit 750306e 'reframe moka init as host-adapter install'). validate/explain-plan remain: BUILTIN_PIPE_COMMANDS = run/validate/explain-plan/doctor/init/mcp/submit/argo/runner-command/ticket (src/commands/pipeline-command.ts:5). So: `moka init --host opencode` (+ its check flag) and `moka validate`.
- AC#3: scheduled + team-graph artifacts then `moka validate` + `moka explain-plan`.
- AC#5: runner-job path overlaps proven dogfoods (PIPE-50.5, 91.9, 94.9 all Done) — reuse that evidence rather than re-probing.
No fresh dogfood evidence recorded on this ticket yet.
<!-- SECTION:NOTES:END -->
