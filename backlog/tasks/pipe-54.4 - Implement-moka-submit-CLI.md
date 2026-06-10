---
id: PIPE-54.4
title: Implement moka submit CLI
status: Done
assignee: []
created_date: '2026-06-10 14:09'
updated_date: '2026-06-10 14:32'
labels:
  - momokaya
  - cli
dependencies:
  - PIPE-54.3
references:
  - package.json
  - src/index.ts
  - src/commands/runner-command-command.ts
  - tests/cli.test.ts
modified_files:
  - package.json
  - src/index.ts
  - tests/cli.test.ts
parent_task_id: PIPE-54
priority: high
ordinal: 168000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Expose the new primary command shape: `moka submit`. This replaces top-level quick/execute and argo submit-command as user-facing submission commands.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 package.json bin installs `moka` as the primary binary
- [ ] #2 CLI help shows `submit` with task-description mode, `--quick`, `--schedule <path>`, and `--command -- <argv...>`
- [ ] #3 `moka submit "build the feature"` calls the submission service in full mode
- [ ] #4 `moka submit --quick "fix this"` calls the submission service in quick mode
- [ ] #5 `moka submit --schedule schedule.yaml "build this"` submits the provided schedule
- [ ] #6 `moka submit --command -- codex -p fix` calls the submission service in command mode
- [ ] #7 Top-level `quick`, `execute`, and `argo submit-command` are absent from help and rejected by Commander
- [ ] #8 `runner-command` remains registered for container use
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Update createCliProgram and package metadata. Prefer Commander options and a Zod option parser at the command boundary for normalized submit inputs. Keep the command-mode separator explicit via `--command --`; do not infer custom-command mode from raw `--` alone.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented the moka submit CLI surface. Top-level quick/execute and argo submit-command are removed from help; submit supports --quick, --schedule, --command, --event-url, and runner Argo options.
<!-- SECTION:FINAL_SUMMARY:END -->
