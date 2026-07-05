---
id: PIPE-54.6
title: Refresh Moka docs and container references
status: Done
assignee: []
created_date: "2026-06-10 14:10"
updated_date: "2026-06-10 14:32"
labels:
  - momokaya
  - docs
  - docker
dependencies:
  - PIPE-54.4
references:
  - README.md
  - docs/operator-guide.md
  - docs/pipeline-console-runner-contract.md
  - Dockerfile
  - tests/runner-image.test.ts
  - tests/package-public-api.test.ts
modified_files:
  - README.md
  - docs/operator-guide.md
  - docs/pipeline-console-runner-contract.md
  - Dockerfile
  - tests/runner-image.test.ts
  - tests/package-public-api.test.ts
parent_task_id: PIPE-54
priority: high
ordinal: 170000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Update public docs, operator docs, package API smoke expectations, and the runner image command references to the Moka command vocabulary.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 README and operator guide use `moka submit` examples for full, quick, schedule-backed, and explicit command submissions
- [ ] #2 Docs no longer present `pipe quick`, `pipe execute`, or `pipe argo submit-command` as current user-facing commands
- [ ] #3 Dockerfile entrypoint and image tests use the installed `moka` binary while preserving `runner-command` as CMD
- [ ] #4 Public API smoke tests expect the `moka` binary and current exports
- [ ] #5 Operator docs still explain that Argo Workflows are the execution substrate and runner-command is the task container entrypoint
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Update documentation and tests after the CLI behavior is implemented. Keep package publishing standard unchanged: no local publish or image push.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Updated docs and container references for Moka: package bin is moka, Dockerfile verifies moka, Argo runner containers invoke moka runner-command, and operator docs describe moka submit.

<!-- SECTION:FINAL_SUMMARY:END -->
