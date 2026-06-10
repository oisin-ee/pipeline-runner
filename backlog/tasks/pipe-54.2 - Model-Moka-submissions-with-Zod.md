---
id: PIPE-54.2
title: Model Moka submissions with Zod
status: Done
assignee: []
created_date: '2026-06-10 14:09'
updated_date: '2026-06-10 14:32'
labels:
  - momokaya
  - zod
  - contract
dependencies:
  - PIPE-54.1
references:
  - src/runner-command-contract.ts
  - tests/runner-command-contract.test.ts
modified_files:
  - src/runner-command-contract.ts
  - tests/runner-command-contract.test.ts
parent_task_id: PIPE-54
priority: high
ordinal: 166000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Replace the runner payload's user-intent shape from `command: quick|execute|custom` to an explicit Moka submission model validated with Zod. The model must distinguish task graph submissions from explicit argv submissions without coupling execution to node types.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Runner payload schema exposes a Zod-validated submission object rather than a loose command enum
- [ ] #2 Task graph submissions encode mode `full` or `quick`
- [ ] #3 Explicit argv submissions encode command argv without implying quick/execute semantics
- [ ] #4 Builder/parser tests cover full graph, quick graph, explicit argv, invalid mode, and unknown fields
- [ ] #5 Public exports remain Zod-first: schema, builder, parser, and types; no exported JSON schema or internal version constant
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Update src/runner-command-contract.ts and its tests. Keep payload validation strict. Preserve event/repository/run/task metadata, but move the submission intent into a typed object. Do not add casts or fallback parsing branches.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented Zod-backed Moka submission payloads through runnerCommandPayloadSchema with submission.kind graph/command and graph mode full/quick.
<!-- SECTION:FINAL_SUMMARY:END -->
