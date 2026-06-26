---
id: PIPE-89.3
title: >-
  agent-auth CLI (agent-auth materialize --runner …) for shell/Docker/Nix/TF
  consumers
status: To Do
assignee: []
created_date: '2026-06-22 20:30'
updated_date: '2026-06-22 20:40'
labels: []
dependencies: []
references:
  - src/runtime/exit-codes.ts
modified_files:
  - packages/agent-auth/src/cli.ts
parent_task_id: PIPE-89
priority: high
ordinal: 256000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: thin CLI over the lib so non-TS consumers (pipeline-runner image entrypoint, coder tf, nix) invoke the same code. Flags: --runner, --source, --check, --dry-run. Exit codes from runtime/exit-codes pattern.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 CLI materializes for a given runner -- Evidence: invoke in tmp HOME, assert files + exit 0
- [ ] #2 Non-zero exit on bad/missing source -- Evidence: test asserts exit code + stderr
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order
- [ ] #2 CLI integration test passes -- record output
<!-- DOD:END -->
