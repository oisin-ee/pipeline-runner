---
id: PIPE-45.11
title: Split agent-node execution surface
status: To Do
assignee: []
created_date: '2026-06-27 14:03'
labels: []
dependencies:
  - PIPE-45.4
references:
  - src/runtime/agent-node/agent-node.ts
modified_files:
  - src/runtime/agent-node/agent-node.ts
  - tests/runtime-actor-contract-boundary.test.ts
parent_task_id: PIPE-45
priority: high
ordinal: 306000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: Split src/runtime/agent-node/agent-node.ts into prompt/context preparation, host process/session execution, result parsing, event emission, and retry/error policy.
Dependencies: PIPE-45.4
Likely modified files: src/runtime/agent-node/agent-node.ts, src/runtime/agent-node/*, tests/runtime-actor-*.test.ts
Reuse: @opencode-ai/sdk and existing runner/session abstractions; no subprocess scraping rewrite unless already ticketed separately.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Agent-node execution concerns have named modules with one owner each -- Evidence: source inspection.
- [ ] #2 Agent-node public/runtime behaviour remains stable -- Evidence: focused runtime actor/agent tests pass.
- [ ] #3 src/runtime/agent-node/agent-node.ts falls below 1k lines or records structural justification -- Evidence: wc/fallow output.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order and record proof.
<!-- DOD:END -->
