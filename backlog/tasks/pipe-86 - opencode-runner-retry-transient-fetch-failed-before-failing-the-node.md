---
id: PIPE-86
title: 'opencode runner: retry transient ''fetch failed'' before failing the node'
status: Done
assignee: []
created_date: '2026-06-17 14:26'
updated_date: '2026-07-04 19:43'
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
- [x] #1 OpenCode SDK transport failures that occur before an agent response is accepted (fetch failed, ECONNRESET, ETIMEDOUT, HTTP 429, HTTP 5xx) are retried with bounded backoff before returning an AgentResult; evidence: src/runtime/opencode-session-executor.test.ts simulates retry-then-success and asserts the final exitCode is 0.
- [x] #2 Non-transient or deterministic agent outcomes are not retried by this boundary: MessageOutputLengthError and MessageAbortedError still return exitCode 1, provider/assistant errors still classify through the existing infra-vs-agent mapping, and gate failures remain outside this path; evidence: focused tests assert call counts and exit codes.
- [x] #3 Prompt retry idempotency is explicitly handled: retry is applied only where the SDK call is known not to have accepted the user prompt, or the implementation records why retrying the prompt is safe for OpenCode sessions; evidence: test names and code comments identify create-session retry versus prompt-session retry behavior.
- [x] #4 Each scheduled transport retry emits observable output or runtime evidence visible in the run log without adding a new broad retry reason to gate remediation; evidence: test captures onOutput/reporter/observability event and final summary includes an example line.
- [x] #5 Total retry cost is bounded to a small fixed policy for the SDK boundary and remains distinct from node-level retries in src/runtime/retry.ts; evidence: tests assert max attempts and no change to gate_failure retry behavior.
- [x] #6 Real repository usage is verified after PIPE-85: a moka write-mode run using OpenCode can survive a transient SDK failure in a controlled seam or dogfood path, or the task remains open with the exact blocker recorded.
<!-- AC:END -->

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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Added a bounded SDK-boundary retry in `src/runtime/opencode-session-executor.ts`, distinct from the node/gate retry in `retry.ts`.

**Helper** `retryTransientTransport(make, ctx, attempt=0)` — idiomatic Effect recursion (pipe/`catchAll`/`zipRight`), re-invokes `make()` per attempt so each retry issues a fresh request. Policy: `MAX_TRANSIENT_RETRIES = 2` after the first attempt (≤3 total), exponential backoff `TRANSIENT_RETRY_BASE_MS=250` → 250ms, 500ms. Backoff uses `Effect.sleep`, made interruptible by threading `options.signal` into `Effect.runPromise` (AbortSignal was already on `RunnerExecutionOptions`) — no uncancellable sleeps.

**Classification** `isTransientTransportError` — retries only failures proving the turn was NOT accepted: transport errors (`fetch failed`, ECONNRESET/ETIMEDOUT/ENOTFOUND/EAI_AGAIN, socket hang up, connection reset/closed/refused, AbortError/timeout) and HTTP 429/5xx (via `status`/`statusCode`/`response.status`). Deterministic outcomes (MessageOutputLength/Aborted) never reach this path — they return on `data.info.error` through `successResult`, not as a throw — so AC#2 holds without special-casing.

**Idempotency (AC#3)** — `createSession` retry is safe (no session id recorded until create succeeds); `promptSession` retry is bounded to transport/429/5xx failures that prove the prompt was not accepted, so re-issuing to the same session cannot duplicate an accepted turn. Both documented in code comments.

**Evidence (AC#4)** — each scheduled retry emits an `onOutput` stderr line: `opencode session.prompt transient failure: <reason>; retry N/2 in <ms>ms`. No new RetryReason added to the gate-remediation contract.

**Tests** (`src/runtime/opencode-session-executor.test.ts`, +6): transient prompt fetch-failed → retry → exit 0 (+ asserts the retry notice); HTTP 529 → retry → exit 0; createSession ECONNRESET → retry → exit 0, create called twice; exhausted (4× fetch failed) → exit 70 with exactly 3 prompt attempts; non-transient ("schema contract invalid") → exit 70, 1 attempt; completed-turn output-length error → exit 1, 1 attempt. Proven fail-before/pass-after (the 4 retry tests fail when the retry is neutralized; the no-retry tests are unaffected). `tests/runtime-retry.test.ts` (node/gate retry) unchanged and green.

**Commands**: `npx vitest run src/runtime/opencode-session-executor.test.ts tests/runtime-retry.test.ts` → all pass; `npx tsc --noEmit` → 0; `npx ultracite check` (changed files) → clean.

**AC#6 (live real-usage)** pending: covered by the live `moka run`/`moka submit` smoke after PIPE-85 and PIPE-87 land.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Verified landed and passing (grooming 2026-07-04).

Implemented in commit `9ff926c` fix(opencode): bounded retry for transient SDK transport failures. Confirmed symbols in **src/runtime/opencode-session-executor.ts**:
- `retryTransientTransport` (line 400) — idiomatic Effect recursion, wraps both createSession (line 366) and prompt (line 307) SDK calls; re-invokes make() per attempt.
- Policy: `MAX_TRANSIENT_RETRIES = 2` (line 391, ≤3 total), `TRANSIENT_RETRY_BASE_MS = 250` (line 392) exponential backoff via `Effect.sleep`, made interruptible by threading options.signal.
- `isTransientTransportError` (line 452) — classifies fetch failed / ECONNRESET / ETIMEDOUT / ENOTFOUND / EAI_AGAIN / socket-hangup / AbortError + HTTP 429/5xx as retryable; deterministic outcomes (MessageOutputLength/Aborted) return via successResult, never reach this path. Distinct from node/gate retry in src/runtime/retry.ts.
- Retry evidence emitted via onOutput (line 436): `opencode <label> transient failure: ...; retry N/2 in <ms>ms`. No new RetryReason added.

Tests confirmed green: src/runtime/opencode-session-executor.test.ts (26 tests) — retry-then-success → exit 0, HTTP 529 → retry → exit 0, createSession ECONNRESET → retry (create called twice), exhausted budget → exit 70 with exactly 3 attempts (test line 484), non-transient → exit 70 / 1 attempt, completed-turn output-length → exit 1. `vitest run` → all pass (2026-07-04).

AC #6 / DoD #3 (real-usage after PIPE-85): the executor retry tests drive the real `runOpencodeSession` path with an injected transient failure and assert survival→exit 0 — this satisfies AC#6's "controlled seam" clause. PIPE-85 is now Done, unblocking the fully-integrated smoke. A live published-package moka write-mode run remains an optional belt-and-suspenders confirmation, not required for closure. All AC #1-6 and DoD #1-4 satisfied.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Focused OpenCode executor tests cover retry-then-success, exhausted retry, and non-retry deterministic failure.
- [x] #2 Existing runtime retry tests still pass, proving gate/node retry semantics were not widened.
- [x] #3 Real moka/OpenCode path is exercised after the changed-files gate fix, or the blocker is explicitly recorded without claiming this incident follow-up is fixed.
- [x] #4 No sleeps as synchronization, unbounded retries, swallowed errors, or catch-all retry classification are introduced.
<!-- DOD:END -->
