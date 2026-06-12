---
id: PIPE-73
title: Replace agent-node subprocess scraping with opencode serve + @opencode-ai/sdk
status: To Do
assignee: []
created_date: '2026-06-12 20:10'
updated_date: '2026-06-12 20:16'
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
- [ ] #1 @opencode-ai/sdk added as a dependency; agent-node drives opencode via the SDK client instead of subprocess stdout parsing
- [ ] #2 Structured SDK events are mapped into the existing runtime event stream (no loss of current event granularity)
- [ ] #3 Session IDs are recorded in run state for forensics/continuation
- [ ] #4 Runner image starts opencode serve and the runner-command path works end-to-end (dogfood test)
- [ ] #5 Goal-loop continuation still works against SDK-driven sessions
- [ ] #6 Existing agent-node tests updated; pnpm test passes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Execution: the one genuinely hard runtime task in phase 2.
1. Adapter design + SDK integration in opencode-adapter/agent-node — model=opus (event-stream mapping and session lifecycle have real failure modes).
2. Test updates — model=sonnet, parallelizable per test file once the adapter API is fixed.
3. Runner-image/dogfood verification — model=sonnet.
Do NOT use Fable here; Opus for step 1 only, everything downstream is sonnet.
<!-- SECTION:PLAN:END -->
