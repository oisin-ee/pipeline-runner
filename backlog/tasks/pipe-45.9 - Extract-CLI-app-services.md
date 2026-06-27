---
id: PIPE-45.9
title: Extract CLI app services
status: Done
assignee: []
created_date: '2026-06-27 14:03'
labels: []
dependencies:
  - PIPE-45.2
  - PIPE-45.5
  - PIPE-45.6
  - PIPE-45.7
references:
  - src/cli/program.ts
modified_files:
  - src/cli/program.ts
  - src/cli/bootstrap-commands.ts
  - src/cli/loop-commands.ts
  - src/cli/mcp-gateway-commands.ts
  - src/cli/plan-commands.ts
  - src/cli/run-commands.ts
  - src/cli/run-service.ts
  - src/index.ts
  - tests/cli-refactor-boundaries.test.ts
  - tests/cli.test.ts
  - tests/moka-run-cli-resolver.test.ts
parent_task_id: PIPE-45
priority: high
ordinal: 304000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: Shrink src/cli/program.ts by moving command app services to owned modules for run, MCP, init, doctor, and ticket flows while keeping Commander registration thin.
Dependencies: PIPE-45.2, PIPE-45.5, PIPE-45.6, PIPE-45.7
Likely modified files: src/cli/program.ts, src/app/run/*, src/app/mcp/*, src/app/init/*, tests/cli.test.ts
Reuse: commander stays CLI framework; existing command helpers stay preferred.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 src/cli/program.ts is thin command registration, not mixed runtime/MCP/init service logic -- Evidence: `wc -l src/cli/program.ts ...` reports `src/cli/program.ts` at 154 lines; boundary test asserts run/MCP/init/auth/loop internals are absent from `program.ts`.
- [x] #2 CLI command behaviour remains stable -- Evidence: `bun run test tests/cli-refactor-boundaries.test.ts tests/cli.test.ts tests/moka-run-cli-resolver.test.ts tests/moka-run-remote-compat.test.ts tests/moka-doctor-readiness.test.ts tests/supervised-run.test.ts tests/detached-run.test.ts` passed, 82 tests.
- [x] #3 No new command framework or parser is introduced -- Evidence: `package.json` unchanged; installed Commander 14.0.3 remains the CLI framework.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Run feature-implementation workflow in order and record proof.
<!-- DOD:END -->

## Evidence

- RED: `bun run test tests/cli-refactor-boundaries.test.ts` initially failed because the CLI service owner files did not exist and `program.ts` exceeded the boundary limit.
- GREEN/focused: `bun run test tests/cli-refactor-boundaries.test.ts tests/cli.test.ts tests/moka-run-cli-resolver.test.ts tests/moka-run-remote-compat.test.ts tests/moka-doctor-readiness.test.ts tests/supervised-run.test.ts tests/detached-run.test.ts` passed, 82 tests.
- Static: `bun run typecheck` passed.
- Static: `bun run check` passed.
- Static: `pnpm exec fallow audit --changed-since HEAD --production` passed with no issues in 11 changed files.
- Build: `bun run build` passed.
- Security: `pnpm audit --audit-level high` passed; only low/moderate advisories reported.
- Full suite: `bun run test` passed, 148 files, 1097 tests, 41 skipped.
- Diff: `git diff --check` passed.
