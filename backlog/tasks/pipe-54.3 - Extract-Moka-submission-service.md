---
id: PIPE-54.3
title: Extract Moka submission service
status: Done
assignee: []
created_date: "2026-06-10 14:09"
updated_date: "2026-06-10 14:32"
labels:
  - momokaya
  - argo
  - architecture
dependencies:
  - PIPE-54.2
references:
  - src/index.ts
  - src/argo-submit.ts
  - src/schedule-planner.ts
  - src/runner-command-contract.ts
  - tests/cli.test.ts
modified_files:
  - src/moka-submit.ts
  - src/index.ts
  - tests/moka-submit.test.ts
parent_task_id: PIPE-54
priority: high
ordinal: 167000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Move task graph submission and explicit argv submission behind a deep Momokaya submission module. The CLI should call this module; it should not hand-build payloads and Argo submit options inline.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 A dedicated source module owns full graph, quick graph, schedule-backed, and explicit argv submission inputs
- [ ] #2 The module generates a schedule when no schedule path is supplied
- [ ] #3 The module reads and compiles a schedule when `--schedule` is supplied
- [ ] #4 The module builds strict runner payloads through the Zod contract builder
- [ ] #5 The module submits through existing Argo workflow APIs without introducing Kubernetes Job code
- [ ] #6 Focused unit tests verify the module's inputs map to Argo submit calls for full, quick, scheduled, and command submissions
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Create a cohesive module such as src/moka-submit.ts. Move logic currently spread across submitScheduledEntrypointToArgo, submitCustomCommandToArgo, and related flag translation out of src/index.ts. Keep src/argo-submit.ts as the Argo API boundary. Use existing simple-git/git-url-parse libraries; do not add regex parsing.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Implemented src/moka-submit.ts as the shared submission service for graph and explicit argv submissions, reusing Argo Workflow submission code and shared runner payload construction.

<!-- SECTION:FINAL_SUMMARY:END -->
