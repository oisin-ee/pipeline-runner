---
id: PIPE-96
title: 'Event sink durability: retries + terminal-flush hardening'
status: Done
assignee: []
created_date: '2026-07-02 14:28'
updated_date: '2026-07-02 17:48'
labels: []
dependencies: []
references:
  - docs/pipeline-console-runner-contract.md
  - 'https://github.com/sindresorhus/ky#retry'
modified_files:
  - src/runner-event-sink.ts
  - src/runtime/services/runner-event-sink-http-service.ts
  - src/runtime/services/runner-command-io-service.ts
  - tests/runner-event-sink.test.ts
  - tests/runner-command-policy.test.ts
  - docs/pipeline-console-runner-contract.md
priority: high
ordinal: 333000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
What to build: Make runner event delivery durable enough that mid-run and terminal records survive transient event-sink failures without turning successful Argo workflows into Failed workflows only because telemetry flush failed.
Scope: RunnerEventSink queue/retry policy, HTTP post retry settings, runner-command terminal flush handling, and the console-runner contract text that currently promises exit-70.
Dependencies / Blocked by: None - can start immediately.
Likely modified files: src/runner-event-sink.ts, src/runtime/services/runner-event-sink-http-service.ts, src/runtime/services/runner-command-io-service.ts, tests/runner-event-sink.test.ts, tests/runner-command-policy.test.ts, docs/pipeline-console-runner-contract.md.
Research required: ky retry docs for statusCodes/retryOnTimeout/totalTimeout; existing Effect patterns before adding custom retry loops.
Model recommendation:
- Claude: unknown -- no Claude model inventory evidenced in this Codex session.
- Codex: gpt-5.5-high -- multi_agent_v1 metadata exposes gpt-5.5 with high reasoning; choose high because terminal telemetry is externally visible and retry semantics are easy to get subtly wrong.
- OpenCode: moka-code-writer/default -- defaults/profiles.yaml defines moka-code-writer and defaults/pipeline.yaml routes implementation through broker/gpt-5.5 fallbacks; dispatch must revalidate live availability.
Implementation decisions:
- Keep one queue owner in RunnerEventSink. Failed batch sends must leave records queued for a later flush.
- Prefer ky's built-in retry/timeout knobs where they fit. Add bounded terminal retry around flushAndReport only if the sink-level policy cannot express the 60s terminal window.
- Do not implement the stale exit-70 doc claim. Finalizer has no retryStrategy, so exit-70 on telemetry failure would mislabel a PASS run as Argo Failed. Console reconciliation remains the backstop for missing terminal telemetry.
Escalation:
- Met: every AC below with command output.
- Unmet: criterion id, failing command/output, retry policy attempted, and whether blocker is code, doc, or missing test seam.
Origin: pipeline-console target-state spec (pipeline-console/backlog/docs/doc-8), 2026-07-02 audit.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Terminal flush retries with backoff for about 60s before giving up -- Evidence: focused unit test where sink fails then recovers on a later attempt and final workflow.finish reaches the fake endpoint.
- [x] #2 Mid-run batch failures retry on next flush without losing queued events -- Evidence: extended queue-splice/order test proves failed first batch remains queued and later records are delivered in sequence.
- [x] #3 Retry policy covers retryable 408/429/5xx and timeout but does not retry permanent 4xx -- Evidence: RunnerEventSinkHttpService test or ky-adapter test with fake responses for retryable and non-retryable statuses.
- [x] #4 Contract doc no longer claims finalizer exit-70 for telemetry failure -- Evidence: `rg -n "exit-70|exit 70|telemetry" docs/pipeline-console-runner-contract.md` output plus replacement text explaining console reconciliation.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 The feature-implementation workflow was run in order.
- [x] #2 `bun run test -- tests/runner-event-sink.test.ts tests/runner-command-policy.test.ts` passed.
- [x] #3 `bun run typecheck` passed.
- [x] #4 `bun run check` passed.
- [x] #5 Doc amended and ADR/decision note recorded if no existing ADR already captures the exit-70 decision.
<!-- DOD:END -->
