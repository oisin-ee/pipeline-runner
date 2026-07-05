---
id: PIPE-45.8
title: Make credentials and auth single-owner
status: Done
assignee: []
created_date: "2026-06-27 14:03"
labels: []
dependencies:
  - PIPE-45.1
references:
  - src/credentials/broker.ts
  - src/credentials/codex-config.ts
  - src/credentials/file-targets.ts
  - src/credentials/local-codex-auth-sync.ts
  - src/credentials/opencode-config.ts
  - src/credentials/runner.ts
modified_files:
  - src/credentials/broker.ts
  - src/credentials/broker.test.ts
  - src/credentials/codex-config.ts
  - src/credentials/file-targets.ts
  - src/credentials/local-codex-auth-sync.ts
  - src/credentials/opencode-config.ts
  - src/credentials/runner.ts
  - src/credentials/runner.test.ts
  - src/broker-auth.ts
  - src/broker-auth.test.ts
  - src/run-state/opencode-accounts.ts
  - src/run-state/opencode-accounts.test.ts
  - src/codex-auth-sync.ts
  - src/argo-submit.ts
  - src/argo-workflow.ts
  - src/cli/program.ts
  - src/moka-global-config.ts
  - src/moka-submit.ts
  - src/runtime/services/runner-command-io-service.ts
  - tests/credentials-boundaries.test.ts
  - tests/codex-auth-sync.test.ts
  - tests/local-codex-auth-sync.test.ts
  - tests/runner-command-policy.test.ts
  - tests/runner-command.test.ts
parent_task_id: PIPE-45
priority: high
ordinal: 303000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: security
Scope: Consolidate broker auth, Codex auth sync, OpenCode account material, and credential path handling behind one credential/auth module family.
Dependencies: PIPE-45.1
Likely modified files: src/broker-auth.ts, src/credentials/\*, src/run-state/opencode-accounts.ts, src/codex-auth-sync.ts, tests/codex-auth-sync.test.ts
Reuse: existing secure-json-parse, filesystem helpers, and host auth contracts; no custom crypto or secret parser.
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Auth/credential file handling has one owner and clear trust boundary -- Evidence: source inspection: broker env/schema, Codex config projection, OpenCode config projection, credential file targets/writes, runner preparation, and local sync now live under `src/credentials/*`; old owner files `src/broker-auth.ts`, `src/codex-auth-sync.ts`, and `src/run-state/opencode-accounts.ts` were deleted, not left as aliases/facades; `tests/credentials-boundaries.test.ts` enforces the boundary.
- [x] #2 Secrets are not logged, printed, or embedded in Backlog/docs -- Evidence: runner logs still receive only `brokerConfigured` basenames; `formatCodexAuthSyncResult` has an explicit no-secret regression test; `auth.json` writes are forced to `0600`; `rg` review found no production secret literals in the changed credential code; `pnpm audit --prod --audit-level high` exited 0 with one moderate advisory only.
- [x] #3 Auth sync behaviour remains compatible -- Evidence: `bun run test tests/credentials-boundaries.test.ts src/credentials/broker.test.ts src/credentials/runner.test.ts tests/local-codex-auth-sync.test.ts` passed 4 files / 20 tests after the boundary test was observed RED before the move.
<!-- AC:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 Run security workflow: secure, trust-boundary review, abuse/error tests, verify. Proof: `bun run typecheck` passed; `bun run check` passed; `pnpm exec fallow audit --changed-since HEAD --production` exited 0 for changed files with only inherited warnings excluded by the new-only gate; `pnpm audit --prod --audit-level high` exited 0; `bun run build` passed; `git diff --check` passed; full `bun run test` passed 148 files / 1096 tests with 5 files / 41 tests skipped.
<!-- DOD:END -->
