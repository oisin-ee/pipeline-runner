---
id: PIPE-91.2
title: Node-execution protocol types (next-node envelope + submit-result)
status: To Do
assignee: []
created_date: '2026-06-26 17:21'
labels: []
dependencies: []
references:
  - docs/moka-orchestrator-design.md
modified_files:
  - src/runtime/node-protocol/node-protocol.ts
  - src/runtime/node-protocol/index.ts
parent_task_id: PIPE-91
priority: high
ordinal: 276000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation (pin the open design risk first — the types ARE the spec)
Scope: deep module src/runtime/node-protocol/ defining the executor-agnostic contract between moka and any node executor (the spawn plug OR the human/debug plug — decision #1). Two shapes: the NextNodeEnvelope EMITTED by 'moka next node' (runId, nodeId, prompt, read-only acceptance criteria, upstream node outputs) and the SUBMIT input accepted by submit-result (a RuntimeNodeResult for (runId,nodeId)). Zod schemas so both directions round-trip across a process/serialization boundary (the debug plug crosses processes). Resolves the design OPEN RISK 'node-execution protocol shape unspecified' and is the shared contract B.6/B.7 consume. Criteria in the envelope are read-only (decision #7). Cut FIRST, parallel with PIPE-91.1. THIS is the make-or-break ticket — get the shape wrong and every stepping command churns.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 NextNodeEnvelope + SubmitResult zod schemas parse/serialize round-trip -- Evidence: unit test JSON round-trips both shapes incl. upstream outputs + criteria
- [ ] #2 Envelope carries prompt + read-only criteria + upstream outputs for one node -- Evidence: unit test builds an envelope from a node + its deps and asserts the fields
- [ ] #3 Submit input validates a RuntimeNodeResult keyed (runId,nodeId); malformed input rejected -- Evidence: unit test rejects a result missing required fields with a structured error
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 pnpm run check + node-protocol unit tests ran fresh; output recorded
<!-- DOD:END -->
