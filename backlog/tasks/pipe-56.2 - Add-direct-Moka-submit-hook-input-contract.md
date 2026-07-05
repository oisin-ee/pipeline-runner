---
id: PIPE-56.2
title: Add direct Moka submit hook input contract
status: Done
assignee:
  - "@codex"
created_date: "2026-06-10 22:12"
updated_date: "2026-06-10 22:46"
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

- [x] #1 Moka submit exports Zod schemas and z.input/z.output-derived types for a direct hooks record keyed by supported hook event names.
- [x] #2 Each event value is one command or module handler object with explicit failure, input, publishResult, timeoutMs, and trust fields where applicable.
- [x] #3 Unsupported hook event names fail validation with a clear schema error.
- [x] #4 The public API test compiles an external consumer that passes one node.finish hook without constructing hooks.functions or hooks.on arrays.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Define the public hook input type in src/moka-submit.ts or a small exported API module. Reuse the existing HookEvent source of truth where possible, but do not export runtime binding internals as the public shape.

<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

Added exported direct hook schemas/types for Moka submit. External TypeScript consumer compiles with a node.finish command hook, unsupported hook events fail schema validation, and submitMoka normalizes direct hook input into internal hook config.

<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Added the public direct hook input contract for moka-submit. The API exports schemas and z.input/z.output-derived types, supports one command or module handler per supported hook event, rejects unsupported events, and public API tests compile an external consumer using a node.finish hook without exposing internal hooks.functions/hooks.on arrays.

<!-- SECTION:FINAL_SUMMARY:END -->
