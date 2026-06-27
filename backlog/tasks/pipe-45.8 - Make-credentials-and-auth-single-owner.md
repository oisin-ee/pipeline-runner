---
id: PIPE-45.8
title: Make credentials and auth single-owner
status: To Do
assignee: []
created_date: '2026-06-27 14:03'
labels: []
dependencies:
  - PIPE-45.1
references:
  - src/broker-auth.ts
  - src/codex-auth-sync.ts
modified_files:
  - src/broker-auth.ts
  - src/run-state/opencode-accounts.ts
  - src/codex-auth-sync.ts
  - tests/codex-auth-sync.test.ts
parent_task_id: PIPE-45
priority: high
ordinal: 303000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: security
Scope: Consolidate broker auth, Codex auth sync, OpenCode account material, and credential path handling behind one credential/auth module family.
Dependencies: PIPE-45.1
Likely modified files: src/broker-auth.ts, src/credentials/*, src/run-state/opencode-accounts.ts, src/codex-auth-sync.ts, tests/codex-auth-sync.test.ts
Reuse: existing secure-json-parse, filesystem helpers, and host auth contracts; no custom crypto or secret parser.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Auth/credential file handling has one owner and clear trust boundary -- Evidence: source inspection.
- [ ] #2 Secrets are not logged, printed, or embedded in Backlog/docs -- Evidence: security review and tests.
- [ ] #3 Auth sync behaviour remains compatible -- Evidence: focused auth tests pass.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run security workflow: secure, trust-boundary review, abuse/error tests, verify.
<!-- DOD:END -->
