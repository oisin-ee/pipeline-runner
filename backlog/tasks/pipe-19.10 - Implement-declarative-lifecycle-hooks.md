---
id: PIPE-19.10
title: Implement declarative lifecycle hooks
status: Done
assignee: []
created_date: "2026-05-24 14:18"
updated_date: "2026-05-25 09:44"
labels:
  - pipeline
  - hooks
dependencies:
  - PIPE-19.1
  - PIPE-19.3
references:
  - src/mastra/pipeline-primitive.ts
modified_files:
  - src/mastra/config.ts
  - src/pipeline-runtime.ts
  - tests/pipeline-runtime.test.ts
parent_task_id: PIPE-19
priority: medium
ordinal: 29000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Add declarative hooks as runtime callbacks owned by the pipeline engine. Hooks should be command or builtin callbacks on known workflow/node/gate lifecycle events. They must not be arbitrary in-process JS or TS functions in v1.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Supported hook events include workflow start, workflow success, workflow failure, workflow complete, node start, node success, node error, and gate failure.
- [x] #2 Hooks can run command or builtin callbacks with configured timeout, required/optional behavior, and templated runtime variables.
- [x] #3 Required hook failure fails the relevant workflow stage; optional hook failure is recorded but does not block execution.
- [x] #4 Hooks are executed by the pipeline runtime, not by model agents.
- [x] #5 Tests cover hook event dispatch, templating, timeout behavior, required failure, optional failure, and ordering.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Implemented declarative command/builtin lifecycle hooks for workflow, node, and gate events with templating, timeout plumbing, and required versus optional failure behavior.

<!-- SECTION:FINAL_SUMMARY:END -->
