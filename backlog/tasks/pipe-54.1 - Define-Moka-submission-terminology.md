---
id: PIPE-54.1
title: Define Moka submission terminology
status: Done
assignee: []
created_date: '2026-06-10 14:09'
updated_date: '2026-06-10 14:32'
labels:
  - momokaya
  - cli
  - docs
dependencies: []
references:
  - docs/operator-guide.md
  - docs/config-architecture.md
  - README.md
modified_files:
  - docs/operator-guide.md
  - README.md
parent_task_id: PIPE-54
priority: high
ordinal: 165000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Settle the product vocabulary before code changes: Moka is the command surface for submitting work to the Momokaya cluster. A submission compiles a graph and runs it as an Argo Workflow. Argo is not the normal user command vocabulary. runner-command is the container task entrypoint.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Docs define Moka, Momokaya submission, graph, quick mode, command mode, and runner-command
- [ ] #2 The decision explicitly rejects `pipe` as the public command vocabulary for this path
- [ ] #3 The decision explicitly marks Argo as implementation/operations vocabulary, not the default user-facing submission command
- [ ] #4 No compatibility-wrapper language is introduced; the intended end state is the proper Moka surface
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add or update the smallest persistent architecture note that future implementers will read before touching CLI code. Use existing docs/ADR style. Do not change command behavior in this ticket.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented as part of PIPE-54. The public terminology is Moka submit: graph submissions are full/quick, explicit argv uses command mode, and runner-command remains the in-container task entrypoint.
<!-- SECTION:FINAL_SUMMARY:END -->
