---
id: PIPE-73
title: Replace agent-node subprocess scraping with opencode serve + @opencode-ai/sdk
status: Done
assignee: []
created_date: '2026-06-12 20:10'
updated_date: '2026-07-04 19:42'
labels:
  - 'repo:pipeline'
  - phase-2
  - runtime
dependencies:
  - PIPE-71
references:
  - report/architecture-review-2026-06-12.md
  - 'https://opencode.ai/docs/server/'
  - 'https://opencode.ai/docs/sdk/'
priority: high
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
src/runtime/agent-node/agent-node.ts (609 lines) spawns the opencode CLI as a subprocess and parses its output. opencode now ships a headless server (`opencode serve`, OpenAPI 3.1) and an official typed SDK (@opencode-ai/sdk, v1.17.x): createOpencode()/createOpencodeClient(), session lifecycle (create/fork/child), async prompting, per-message agent/model selection, and a structured event stream.

Rework the opencode adapter (src/runtime/opencode-adapter.ts + agent-node) to drive a served instance via the SDK: structured events instead of stdout scraping, session IDs as first-class run state, and the SDK event stream forwarded into the runtime event system. In runner pods, the runner starts `opencode serve` and drives it over localhost.

This is required regardless of any execution-engine decision (Hatchet or Argo) — it replaces the most fragile code in the runtime with maintained vendor code.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 @opencode-ai/sdk added as a dependency; agent-node drives opencode via the SDK client instead of subprocess stdout parsing
- [x] #2 Structured SDK events are mapped into the existing runtime event stream (no loss of current event granularity)
- [x] #3 Session IDs are recorded in run state for forensics/continuation
- [x] #4 Runner image starts opencode serve and the runner-command path works end-to-end (dogfood test)
- [x] #5 Goal-loop continuation still works against SDK-driven sessions
- [x] #6 Existing agent-node tests updated; pnpm test passes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Execution: the one genuinely hard runtime task in phase 2.
1. Adapter design + SDK integration in opencode-adapter/agent-node — model=opus (event-stream mapping and session lifecycle have real failure modes).
2. Test updates — model=sonnet, parallelizable per test file once the adapter API is fixed.
3. Runner-image/dogfood verification — model=sonnet.
Do NOT use Fable here; Opus for step 1 only, everything downstream is sonnet.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Shipped — commit 33412a8 "feat: drive opencode via serve + SDK in agent runtime (PIPE-73 core)". `@opencode-ai/sdk` 1.17.4 is a dependency. The subprocess-scraping monolith is gone: `src/runtime/agent-node/agent-node.ts` shrank from 609 to 213 lines and now delegates to SDK-driven executors. `src/runtime/opencode-session-executor.ts` drives sessions via the SDK (`promptSession`, `session.create`, native `session.abort`; imports `@opencode-ai/sdk/v2`). `src/runtime/opencode-server.ts` runs ONE `opencode serve` per run: local runs spawn via `createOpencode()`, runner pods pre-start `opencode serve` and connect via `OPENCODE_SERVER_URL` with `createOpencodeClient()`. Structured SDK SSE events are pumped and forwarded into the runtime event stream (opencode-session-executor.ts pumpEvents, ~line 541 "forward structured SDK events into"), with an idle watchdog on the event gap. Session IDs recorded in run state: `session-execution.ts` → `context.nodeStateStore.recordSessionId(node.id, result.sessionId)`. Tests updated/colocated: `agent-node.test.ts`, `opencode-session-executor.test.ts`, `opencode-server.test.ts`, `opencode-runtime.test.ts`. Note: PIPE-104 (yeet-backed opencode executor epic, added 2026-07-04) is a separate follow-on, not part of this core rework.
<!-- SECTION:FINAL_SUMMARY:END -->
