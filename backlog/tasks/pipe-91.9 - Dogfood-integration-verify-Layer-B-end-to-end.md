---
id: PIPE-91.9
title: Dogfood + integration verify Layer B end-to-end
status: To Do
assignee: []
created_date: '2026-06-26 17:22'
labels: []
dependencies:
  - PIPE-91.5
  - PIPE-91.6
  - PIPE-91.7
  - PIPE-91.8
references:
  - docs/moka-orchestrator-design.md
parent_task_id: PIPE-91
priority: high
ordinal: 283000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: verify (verification, no production code)
Scope: end-to-end proof of Layer B on real work, via the PUBLISHED package path per the project verification rule (push -> CI version bump -> global package install -> real moka commands), NOT local builds: (a) start a run with db.url set, kill it, 'moka resume' to completion from Postgres; (b) step a run node-by-node via 'moka next node' + submit-result across SEPARATE process invocations. Confirms moka owns the cross-invocation loop on the durable substrate and the debug plug round-trips through the node-execution protocol.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Kill + resume completes a real run from Postgres with no node re-run -- Evidence: recorded transcript of the resumed run + node statuses before/after
- [ ] #2 Node-by-node stepping drives a run to terminal via the CLI across invocations -- Evidence: recorded next-node/submit-result transcript across separate processes
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the verify workflow with fresh evidence
- [ ] #2 Verified via the published global package, not a local build; output recorded
<!-- DOD:END -->
