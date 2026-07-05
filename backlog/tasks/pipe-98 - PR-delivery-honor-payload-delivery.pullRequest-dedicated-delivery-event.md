---
id: PIPE-98
title: "PR delivery: honor payload delivery.pullRequest + dedicated delivery event"
status: Done
assignee: []
created_date: "2026-07-02 14:30"
updated_date: "2026-07-02 17:48"
labels: []
dependencies:
  - PIPE-101
references:
  - src/remote/submit/compilation.ts
  - src/schedule/passes/open-pull-request.ts
  - src/runtime/open-pull-request/open-pull-request.ts
  - src/runner-event-schema.ts
modified_files:
  - src/remote/submit/compilation.ts
  - src/schedule/passes/open-pull-request.ts
  - src/planning/generate.ts
  - src/runtime/open-pull-request/open-pull-request.ts
  - src/runner-event-schema.ts
  - src/runner-command-contract.ts
  - src/remote/submit/event-boundary.ts
  - tests/moka-submit.test.ts
  - src/schedule/passes/open-pull-request.test.ts
  - src/runtime/open-pull-request/open-pull-request.test.ts
  - src/runner-event-schema.test.ts
priority: high
ordinal: 335000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
What to build: Make graph submissions honor the submitted payload's PR delivery intent and emit a typed PR-delivery event that consumers can render without parsing node.output.recorded text.
Scope: graph-submit delivery flag threading, open-pull-request schedule injection, open-pull-request builtin success output/event emission, runner event schema/type union, and tests for both create/update actions.
Dependencies / Blocked by: PIPE-101, because both tickets edit runner-event-schema.ts/package exports and PIPE-101 establishes the public event/schema export surface first.
Likely modified files: src/remote/submit/compilation.ts, src/schedule/passes/open-pull-request.ts, src/planning/generate.ts, src/runtime/open-pull-request/open-pull-request.ts, src/runner-event-schema.ts, src/runner-command-contract.ts, src/remote/submit/event-boundary.ts, tests/moka-submit.test.ts, src/schedule/passes/open-pull-request.test.ts, src/runtime/open-pull-request/open-pull-request.test.ts, src/runner-event-schema.test.ts.
Research required: existing runner payload delivery contract in runner-command-contract; existing schedule pass convention; no new library expected.
Model recommendation:

- Claude: unknown -- no Claude model inventory evidenced in this Codex session.
- Codex: gpt-5.5-high -- multi_agent_v1 metadata exposes gpt-5.5 with high reasoning; choose high because this changes a public event contract and graph-generation behavior.
- OpenCode: moka-code-writer/default -- defaults/profiles.yaml defines moka-code-writer and defaults/pipeline.yaml routes implementation through broker/gpt-5.5 fallbacks; dispatch must revalidate live availability.
  Implementation decisions:
- Payload `delivery.pullRequest: true` is authoritative for graph submissions. Payload absent/false preserves existing config-driven behavior.
- Keep open-pull-request builtin result structured at source. Do not make consumers parse JSON from node.output.recorded.
- Use one typed event shape, e.g. `delivery.pull-request` with `{ action: "opened" | "updated", url }`, exported through the existing events public subpath.
  Escalation:
- Met: every AC below with command output.
- Unmet: criterion id, failing command/output, and whether blocker is delivery flag plumbing, event emission seam, or consumer contract.
Origin: pipeline-console target-state spec (pipeline-console/backlog/docs/doc-8), 2026-07-02 audit.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Graph submit with delivery.pullRequest=true appends an open-pull-request node without target-repo config opt-in -- Evidence: submit/compile or schedule-generation unit test asserting open-pull-request node present.
- [x] #2 Graph submit with delivery.pullRequest absent or false preserves current config-driven behavior -- Evidence: regression test covering absent/false payload delivery.
- [x] #3 delivery.pull-request event with {action,url} appears in the exported runnerEventRecordSchema union -- Evidence: runner-event-schema test parses both opened and updated variants.
- [x] #4 open-pull-request builtin emits the typed event for PR open and update -- Evidence: builtin unit test captures event records for both success paths.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

Consumer dependency note (2026-07-02): pipeline-console PR-link ticket depends on `delivery.pull-request` from @oisincoveney/pipeline/events and must not parse `node.output.recorded` JSON for PR links.

<!-- SECTION:NOTES:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 The feature-implementation workflow was run in order.
- [x] #2 `bun run test -- tests/moka-submit.test.ts src/schedule/passes/open-pull-request.test.ts src/runtime/open-pull-request/open-pull-request.test.ts src/runner-event-schema.test.ts` passed.
- [x] #3 `bun run typecheck` passed.
- [x] #4 `bun run check` passed.
- [x] #5 Consumer note recorded: pipeline-console PR-link ticket depends on `delivery.pull-request`.
<!-- DOD:END -->
