---
id: PIPE-28
title: Add configurable task context resolver interface
status: Done
assignee: []
created_date: '2026-05-25 20:02'
updated_date: '2026-05-25 20:32'
labels:
  - task-context
  - config
  - adapters
dependencies:
  - PIPE-25
priority: medium
ordinal: 40000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Introduce a generic task context interface so acceptance criteria and task metadata can be supplied to the runtime deterministically without coupling core runtime to Backlog, Beads, Linear, GitHub, or any other task system.

The core runtime should consume normalized task context. Project config should decide whether context comes from Markdown files, a command, a future task-tool adapter, or an explicit library caller. This keeps acceptance enforcement generic while letting this repo dogfood a Backlog Markdown resolver later.

Scope:
- Define normalized task context types for task id, title, description, and acceptance criteria.
- Add `taskContext?: PipelineTaskContext` to runtime/library inputs.
- Add optional config for task-context resolver selection without making any resolver mandatory.
- Inject resolved/provided task context into agent prompts as canonical context.
- Keep free-form task descriptions working when no task context is available.

Resolver boundary:
- Core should define the interface and normalized shape.
- Specific resolvers are adapters. A Markdown resolver may be implemented here if kept optional and config-selected; it must not become a core assumption.

Non-goals:
- Do not require Backlog Markdown in every project.
- Do not implement acceptance coverage gating in this task.
- Do not require all tasks to have acceptance criteria.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Runtime supports normalized taskContext.
- [x] #2 Config can declare a task-context resolver.
- [x] #3 Core does not hardcode any specific task system.
- [x] #4 Backlog Markdown resolver is optional and repo-configured if implemented.
- [x] #5 Resolved acceptance criteria are injected into agent prompts as canonical context.
- [x] #6 Free-form tasks still work when no resolver is configured.
- [x] #7 Library callers can pass explicit task context without using a resolver.
- [x] #8 Tests cover resolver miss and tasks without acceptance criteria.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Define `PipelineTaskContext` and `AcceptanceCriterion` types in a core module.
2. Extend runtime options/context to accept explicit task context from library callers.
3. Add config schema for an optional `task_context` block with resolver type and resolver-specific settings.
4. Implement no-op behavior when no resolver is configured or no task id can be resolved.
5. If adding Markdown resolver in this task, keep it generic/configured: glob pattern, id pattern, AC block markers, and no hardcoded Backlog dependency.
6. Inject a canonical task-context section into `renderAgentPrompt` before node-specific dependency outputs.
7. Add tests for explicit task context, no resolver/free-form task, resolver miss, and prompt injection.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added normalized task context types, runtime/library taskContext input, optional resolver config surface, canonical prompt injection, free-form fallback behavior, and tests for prompt/context behavior.
<!-- SECTION:FINAL_SUMMARY:END -->
