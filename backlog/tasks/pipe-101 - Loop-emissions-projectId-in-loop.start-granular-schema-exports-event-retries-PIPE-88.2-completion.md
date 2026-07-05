---
id: PIPE-101
title: >-
  Loop emissions: projectId in loop.start + granular schema exports + event
  retries (PIPE-88.2 completion)
status: Done
assignee: []
created_date: "2026-07-02 14:30"
updated_date: "2026-07-02 17:48"
labels: []
dependencies:
  - PIPE-96
references:
  - src/loop/controller.ts
  - src/loop/controller-deps.ts
  - src/runner-event-schema.ts
  - src/tickets/ticket-graph-dto.ts
  - package.json
modified_files:
  - src/loop/controller.ts
  - src/loop/controller-deps.ts
  - src/runner-event-schema.ts
  - src/runner-command-contract.ts
  - src/tickets/ticket-graph-dto.ts
  - src/tickets/ticket-graph-dto.test.ts
  - package.json
  - tests/dogfood-installed.test.ts
  - src/loop/controller.test.ts
  - src/loop/controller-deps.test.ts
  - src/runner-event-schema.test.ts
priority: high
ordinal: 338000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
What to build: Complete loop event contract so pipeline-console can identify the project, import the exact schemas it consumes, and rely on the same retry policy as normal runner events.
Scope: loop.start details, loop controller context emission, loop event posting retry policy, public package exports for loop/ticket graph schemas, and installed-package proof.
Dependencies / Blocked by: PIPE-96, because loop event POST retries must reuse the hardened sink retry policy from that ticket.
Likely modified files: src/loop/controller.ts, src/loop/controller-deps.ts, src/runner-event-schema.ts, src/runner-command-contract.ts, src/tickets/ticket-graph-dto.ts, src/tickets/ticket-graph-dto.test.ts, package.json, tests/dogfood-installed.test.ts, src/loop/controller.test.ts, src/loop/controller-deps.test.ts, src/runner-event-schema.test.ts.
Research required: package.json export/subpath conventions already used in this repo; no new dependency expected.
Model recommendation:

- Claude: unknown -- no Claude model inventory evidenced in this Codex session.
- Codex: gpt-5.5-medium -- multi_agent_v1 metadata exposes gpt-5.5 with medium reasoning; choose medium because changes are public-contract plumbing with existing tests/seams.
- OpenCode: moka-code-writer/default -- defaults/profiles.yaml defines moka-code-writer and defaults/pipeline.yaml routes implementation through broker/gpt-5.5 fallbacks; dispatch must revalidate live availability.
  Implementation decisions:
- Add projectId to LoopStartDetails and loopStartDetailsSchema. Preserve existing strategy/root compatibility if consumers omit root.
- Export loopStateSchema and ticketGraphDtoSchema through an explicit public subpath. Prefer the existing `./events` subpath only if it remains coherent; otherwise add `./tickets`.
- Reuse the policy values from PIPE-96 instead of hardcoding a new loop-only retry policy.
  Escalation:
- Met: every AC below with command output.
- Unmet: criterion id, failing command/output, and whether blocker is event schema, public exports, or retry policy reuse.
Origin: pipeline-console target-state spec (pipeline-console/backlog/docs/doc-8), 2026-07-02 audit.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 loop.start wire record carries projectId -- Evidence: controller unit test on emitted record and runnerEventRecordSchema parse test for projectId.
- [x] #2 loopStateSchema + ticketGraphDtoSchema importable from a public subpath -- Evidence: dogfood-installed test imports both from built package output.
- [x] #3 loop event POST retries on 5xx using the shared sink retry policy -- Evidence: controller-deps test with flaky sink and assertion on retry count/delay policy source.
- [x] #4 Existing loop.\* events remain schema-compatible -- Evidence: existing runner-event-schema loop tests stay green.
<!-- AC:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 The feature-implementation workflow was run in order.
- [x] #2 `bun run test -- src/loop/controller.test.ts src/loop/controller-deps.test.ts src/runner-event-schema.test.ts src/tickets/ticket-graph-dto.test.ts tests/dogfood-installed.test.ts` passed.
- [x] #3 `bun run typecheck` passed.
- [x] #4 `bun run check` passed.
- [x] #5 `bun run build` passed so package export changes are generated.
<!-- DOD:END -->
