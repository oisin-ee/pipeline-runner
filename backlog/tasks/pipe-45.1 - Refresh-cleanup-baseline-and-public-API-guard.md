---
id: PIPE-45.1
title: Refresh cleanup baseline and public API guard
status: Done
assignee: []
created_date: "2026-06-27 14:01"
updated_date: "2026-06-27 14:09"
labels: []
dependencies: []
references:
  - package.json
  - tests/package-public-api.test.ts
  - tests/dist-contract.test.ts
modified_files:
  - tests/package-public-api.test.ts
  - tests/dist-contract.test.ts
  - >-
    backlog/tasks/pipe-45 -
    Decompose-oversized-source-modules-past-the-1k-line-threshold.md
parent_task_id: PIPE-45
priority: high
ordinal: 296000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
Scope: Freeze public package exports/bin/CLI/config contract before any structural movement. Capture current size/dead-code baseline.
Dependencies: PIPE-45
Likely modified files: tests/package-public-api.test.ts, tests/dist-contract.test.ts, optional tests/refactor-boundaries.test.ts, backlog/tasks/pipe-45\*.md
Reuse: existing package.json exports/bin, Bun/Vitest runner, current fallow/knip tooling. No new dependency.
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Public exports and bin surface are explicitly guarded -- Evidence: tests/package-public-api.test.ts and tests/dist-contract.test.ts pass.
- [x] #2 Cleanup baseline is recorded for current hotspots and dead surface -- Evidence: bun run typecheck, bun run check, bun test, pnpm dlx knip --reporter compact --no-progress, pnpm exec fallow health --production --complexity --targets --hotspots --report-only output recorded in task notes.
- [x] #3 No code cleanup ticket may alter public package exports without updating this guard or adding explicit public API migration evidence -- Evidence: test assertion covers package exports/bin.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

Implementation evidence (2026-06-27):

Research ledger:

- Local: inspected package.json exports/bin, tsdown.config.ts entries, tests/package-public-api.test.ts, tests/dist-contract.test.ts, Backlog task graph, and current source line counts.
- External primary/source/tool: Node.js package docs confirm package exports define/encapsulate public entry points; Backlog CLI help used for task graph mutation; Bun/Vitest commands used from package scripts.

Library-first/reuse decision:

- Used existing package.json exports/bin as contract source, existing Vitest/Bun script path for proof, and existing Zod dependency to validate package.json shape in the test.
- No new dependency, no dependency-cruiser, no custom package-map parser.

Change:

- Added tests/package-public-api.test.ts guard that pins exact package exports map and moka bin surface before structural cleanup.
- Created PIPE-45 child graph PIPE-45.1 through PIPE-45.18 and updated parent scope from stale files to current hotspots.

Proof commands:

- backlog sequence list --plain: PIPE-45.1 first; PIPE-45.2-45.8 parallel after guard; dependent structural tickets sequence after prerequisites; PIPE-45.18 final.
- bunx vitest run tests/package-public-api.test.ts tests/dist-contract.test.ts: passed, 2 files, 8 tests.
- bun run typecheck: passed.
- bun run check: passed, 392 files checked, no fixes applied.
- bun run test: passed, 144 files passed, 5 skipped; 1087 tests passed, 41 skipped. Skips are existing env-gated live suites.
- pnpm dlx knip --reporter compact --no-progress: exited 1 with baseline findings recorded for later deletion ticket: unused files defaults/opencode/plugins/pipeline-goal-context.ts, src/runtime/index.ts, src/schedule/artifact.ts; unused dependency rulesync; unused exports/types listed in output. Exit 1 is expected baseline evidence, not a guard failure.
- pnpm exec fallow health --production --complexity --targets --hotspots --report-only: completed; baseline 45,263 LOC, 158 above threshold, hotspots led by src/index.ts, src/install-commands.ts, src/pipeline-runtime.ts, src/pipeline-init.ts, src/runner.ts, src/runtime/agent-node/agent-node.ts, src/cli/program.ts, src/mcp/gateway.ts, src/moka-submit.ts.
- wc -l top current modules: src/pipeline-runtime.ts 1735, src/cli/program.ts 1338, src/config/schemas.ts 1111, src/runtime/agent-node/agent-node.ts 1075, src/runner-command-contract.ts 963, src/planning/generate.ts 925, src/runtime/hooks/hooks.ts 906, src/runtime/opencode-session-executor.ts 905.
- git diff --check: passed.

Code Rubric:

- Declarative PASS: expected public export map is a data fixture in tests/package-public-api.test.ts.
- Modular/deep PASS: package surface guard is a single public-contract test, not scattered assertions.
- One owner PASS: package exports/bin variation owned by EXPECTED_PUBLIC_EXPORTS plus bin assertion.
- Typed/total PASS: Zod validates package.json shape before assertions.
- Reuse PASS: existing Zod/Vitest/package scripts/Backlog CLI used; no new deps.
- No smells PASS: no casts, suppressions, broad fallback, or generated hand-edit; bun run check and git diff --check passed.
- Verified PASS: focused tests, typecheck, check, full test, knip baseline, fallow baseline ran fresh.

Critique:

- Correctness: guard directly pins Node package exports/bin surface before refactor.
- Security: no secret/auth path touched; package export paths remain relative ./dist paths.
- Performance: test-only/package metadata check; no runtime path changed.
- Maintainability: child graph cuts work by ownership and records library-first constraints.
- Dispatch limitation: host exposes spawn_agent, but tool policy forbids spawning subagents unless user explicitly asks for subagents/delegation/parallel agent work. This slice was executed in main thread with dispatch artifacts preserved.
<!-- SECTION:NOTES:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 Run feature-implementation workflow: research + library-first-development, Build Contract, targeted test, quality-gate/critique, verify.
- [x] #2 Record fresh proof output in implementation notes.
<!-- DOD:END -->
