---
id: PIPE-54
title: 'Epic: Moka submit command surface'
status: In Progress
assignee: []
created_date: '2026-06-10 14:08'
updated_date: '2026-06-10 14:43'
labels:
  - epic
  - momokaya
  - cli
  - argo
dependencies: []
references:
  - src/index.ts
  - src/commands/pipeline-command.ts
  - src/runner-command-contract.ts
  - src/argo-submit.ts
  - src/argo-workflow.ts
  - src/install-commands.ts
  - Dockerfile
  - README.md
  - docs/operator-guide.md
priority: high
ordinal: 164000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Replace the pipe/quick/execute/argo-submit-command user-facing command shape with a Momokaya-oriented submit surface. The primary command is `moka`. Common task submissions compile a graph and submit an Argo Workflow to the Momokaya cluster; arbitrary argv is available only through an explicit command mode. Argo remains the implementation detail and runner-command remains the in-container task entrypoint.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Package installs a primary `moka` binary
- [ ] #2 `moka submit "build the feature"` submits the default/full graph to Argo
- [ ] #3 `moka submit --quick "fix this"` submits the quick graph to Argo
- [x] #4 `moka submit --command -- codex -p "fix"` submits one explicit argv task to Argo
- [ ] #5 `--schedule <path>` uses an approved schedule and absence of `--schedule` generates one before submission
- [x] #6 Old user-facing `quick`, `execute`, and `argo submit-command` surfaces are removed from command help
- [x] #7 `runner-command` remains available for the runner container only
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Scope the change as a command/API migration, not a compatibility wrapper. First define terminology and the payload contract, then extract a Moka submission service, then expose `moka submit`, update generated host resources/docs/container references, and verify with real Argo Workflow submissions.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Partially implemented. package.json exposes moka; explicit argv submission works through moka submit --command --; old quick/execute and argo submit-command user surfaces are removed; runner-command remains available. Full/quick generated graph submission is not complete because the Argo compiler currently only supports explicit command nodes and correctly rejects generated agent/builtin/parallel graph nodes instead of using guessed lowering.
<!-- SECTION:FINAL_SUMMARY:END -->
