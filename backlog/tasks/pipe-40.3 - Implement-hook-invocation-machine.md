---
id: PIPE-40.3
title: Implement hook invocation machine
status: To Do
assignee: []
created_date: '2026-06-03 09:25'
labels:
  - xstate
  - runtime
  - hooks
dependencies:
  - PIPE-40.2
references:
  - src/pipeline-runtime.ts
  - src/config.ts
documentation:
  - 'https://stately.ai/docs/invoke'
modified_files:
  - src/runtime-machines/hook-machine.ts
  - tests/runtime-machines-hook.test.ts
parent_task_id: PIPE-40
priority: high
ordinal: 76000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Build a standalone XState v5 hookInvocationMachine so hooks become first-class observable actors rather than imperative helper calls.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 hookInvocationMachine is created with setup(...).createMachine(...) and typed context/events/actions/guards/actors.
- [ ] #2 The machine exposes queued, running, passed, failed, timedOut, and skipped states with hook/running/terminal/failure/cancelled tags where appropriate.
- [ ] #3 The machine models required vs optional hook failure behavior without masking failures behind default success.
- [ ] #4 The machine emits stable hook observability events for hook.started, hook.finished, hook.failed, hook.timedOut, and hook.skipped through an injected emitter actor/action.
- [ ] #5 Unit tests cover command hook pass, required failure, optional failure, trust-policy skipped hook, disabled command hook, timeout, output limit evidence, and cancellation.
- [ ] #6 No changes are made to dispatchHooks or pipeline-runtime.ts in this ticket.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add src/runtime-machines/hook-machine.ts and tests/runtime-machines-hook.test.ts. Reuse existing HookSpec and HookRuntimePolicy types where possible without introducing circular imports.
<!-- SECTION:PLAN:END -->
