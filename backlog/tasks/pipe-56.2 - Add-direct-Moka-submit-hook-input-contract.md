---
id: PIPE-56.2
title: Add direct Moka submit hook input contract
status: To Do
assignee: []
created_date: '2026-06-10 22:12'
labels:
  - api
  - hooks
  - console
dependencies:
  - PIPE-56.1
modified_files:
  - src/moka-submit.ts
  - src/hooks.ts
  - tests/package-public-api.test.ts
parent_task_id: PIPE-56
priority: high
ordinal: 180000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add a console-facing hooks input to Moka submit that models one lifecycle handler per event directly. The public input must not expose hooks.functions, hooks.on[event] arrays, generated function registries, or YAML-shaped config patches.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Moka submit exports Zod schemas and z.input/z.output-derived types for a direct hooks record keyed by supported hook event names.
- [ ] #2 Each event value is one command or module handler object with explicit failure, input, publishResult, timeoutMs, and trust fields where applicable.
- [ ] #3 Unsupported hook event names fail validation with a clear schema error.
- [ ] #4 The public API test compiles an external consumer that passes one node.finish hook without constructing hooks.functions or hooks.on arrays.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Define the public hook input type in src/moka-submit.ts or a small exported API module. Reuse the existing HookEvent source of truth where possible, but do not export runtime binding internals as the public shape.
<!-- SECTION:PLAN:END -->
