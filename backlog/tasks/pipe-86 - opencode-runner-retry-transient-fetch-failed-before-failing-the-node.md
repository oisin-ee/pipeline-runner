---
id: PIPE-86
title: 'opencode runner: retry transient ''fetch failed'' before failing the node'
status: To Do
assignee: []
created_date: '2026-06-17 14:26'
labels: []
dependencies: []
references:
  - backlog/docs/doc-1
  - src/runtime/opencode-session-executor.ts
  - src/runtime/opencode-session-executor.test.ts
  - src/runtime/retry.ts
  - src/pipeline-runtime.ts
modified_files:
  - src/runtime/opencode-session-executor.ts
  - src/runtime/opencode-session-executor.test.ts
  - src/runtime/services/opencode-sdk-service.ts
  - src/runtime/events/events.ts
  - src/runtime/actor-ids.ts
priority: medium
ordinal: 243000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Secondary failure in moka run run-4a0f183d (see backlog doc-1). The red-backend-resilience-tests node (profile moka-test-writer, runner opencode, model openai/gpt-5.5-high) died with 'stderr: opencode session failed: fetch failed' (agent exit=70, node exit=1) after a single attempt. This is a transient network/model-gateway error (occurred during an upstream API-overload window that also produced repeated 529s). The runner boundary marked the node failed with no transient-aware retry/backoff. Distinct from gate failures (those should NOT be retried this way).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 OpenCode SDK transport failures that occur before an agent response is accepted (fetch failed, ECONNRESET, ETIMEDOUT, HTTP 429, HTTP 5xx) are retried with bounded backoff before returning an AgentResult; evidence: src/runtime/opencode-session-executor.test.ts simulates retry-then-success and asserts the final exitCode is 0.
- [ ] #2 Non-transient or deterministic agent outcomes are not retried by this boundary: MessageOutputLengthError and MessageAbortedError still return exitCode 1, provider/assistant errors still classify through the existing infra-vs-agent mapping, and gate failures remain outside this path; evidence: focused tests assert call counts and exit codes.
- [ ] #3 Prompt retry idempotency is explicitly handled: retry is applied only where the SDK call is known not to have accepted the user prompt, or the implementation records why retrying the prompt is safe for OpenCode sessions; evidence: test names and code comments identify create-session retry versus prompt-session retry behavior.
- [ ] #4 Each scheduled transport retry emits observable output or runtime evidence visible in the run log without adding a new broad retry reason to gate remediation; evidence: test captures onOutput/reporter/observability event and final summary includes an example line.
- [ ] #5 Total retry cost is bounded to a small fixed policy for the SDK boundary and remains distinct from node-level retries in src/runtime/retry.ts; evidence: tests assert max attempts and no change to gate_failure retry behavior.
- [ ] #6 Real repository usage is verified after PIPE-85: a moka write-mode run using OpenCode can survive a transient SDK failure in a controlled seam or dogfood path, or the task remains open with the exact blocker recorded.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] Focused OpenCode executor tests cover retry-then-success, exhausted retry, and non-retry deterministic failure.
- [ ] Existing runtime retry tests still pass, proving gate/node retry semantics were not widened.
- [ ] Real moka/OpenCode path is exercised after the changed-files gate fix, or the blocker is explicitly recorded without claiming this incident follow-up is fixed.
- [ ] No sleeps as synchronization, unbounded retries, swallowed errors, or catch-all retry classification are introduced.
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
HANDOFF PROMPT (oisin-pipeline):
The current code already maps thrown OpenCode session errors to infra exit 70 in src/runtime/opencode-session-executor.ts, and src/runtime/retry.ts can retry nodes only when a node declares retries. The incident still failed after one attempt, so this ticket owns a narrower SDK-boundary retry for transient transport failures before the executor returns the AgentResult.
1. In src/runtime/opencode-session-executor.ts, add a small retry helper around the OpenCode SDK calls, not around gate evaluation or the whole node attempt loop. Keep classification explicit: fetch failed, ECONNRESET, ETIMEDOUT, AbortError/timeout, HTTP 429, and HTTP 5xx are retryable; output-length/aborted message errors, schema/contract problems, and gate failures are not.
2. Treat idempotency as part of the implementation, not an assumption. createSession retry is safe before a session id is recorded. promptSession retry must only happen when the SDK error proves the prompt was not accepted, or else be left to node-level retry with a recorded reason. Do not silently duplicate prompts into the same OpenCode session.
3. Use a small bounded policy, e.g. 2 retries after the first attempt with short exponential or jittered backoff. Honor AbortSignal if one is available through RunnerExecutionOptions; if it is not currently threaded to this seam, either thread it explicitly or record that blocker rather than adding uncancellable sleeps.
4. Emit retry evidence through the existing executor output/reporting path so the run log shows retry attempt, reason, and next delay. Do not add a new RetryReason unless the runtime event contract truly needs it.
5. Add tests in src/runtime/opencode-session-executor.test.ts for retry-then-success, exhausted retry returning exit 70, and non-transient no-retry. Re-run existing runtime retry tests to prove node/gate retry behavior is unchanged.
6. Do not mark partial. If prompt idempotency or cancellation cannot be proven at this boundary, stop and split a smaller preparatory ticket instead of shipping a broad catch-all retry.
<!-- SECTION:PLAN:END -->
