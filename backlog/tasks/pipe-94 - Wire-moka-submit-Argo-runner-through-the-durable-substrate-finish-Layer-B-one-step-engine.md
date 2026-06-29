---
id: PIPE-94
title: >-
  Wire moka submit/Argo runner through the durable substrate (finish Layer B;
  one step engine)
status: Done
assignee: []
created_date: '2026-06-28 19:51'
updated_date: '2026-06-29 06:48'
labels:
  - epic
dependencies: []
references:
  - docs/moka-orchestrator-design.md
priority: high
ordinal: 321000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
PIPE-91 shipped the durable substrate (RunControlStore, DurableRunStore, node-protocol, next node/submit-result/resume CLI) and wired LOCAL moka run into it, but never wired the moka submit / Argo runner path. Result: two parallel DAG-stepping engines. Local moka run persists (createRun + schedule + reporter->updateNodeStatus + journal->record); the submitted/Argo path persists NOTHING durable — runner-command computes a RuntimeNodeResult then collapses it to an exit code and streams events to the external Pipeline Console; runner-lifecycle workflow.start only emits events (no createRun); submit creates only Argo workflow + ConfigMaps. So moka next node / submit-result / resume cannot operate on a submitted run (it never exists in the DB), and buildNextNodeEnvelope/recordSubmitResult/stepNode are an island only the CLI + tests touch.

Goal: make the submitted/Argo path drive through the SAME durable substrate as local, behind ONE canonical step engine, so every run (local or remote) is durable, inspectable, splittable and replayable.

Locked decisions:
- Convergence A: substrate is the persistence underlay; Argo keeps owning DAG ordering + parallel fan-out (we just submit serial/parallel Argo jobs). No driver-loop rewrite.
- Engine L3: one canonical step core. Atomic shared unit stepNode(store,runId,nodeId) = build envelope -> execute -> record result. Selection (computeReadyNodeIds, already shared) stays the caller's concern (Argo on submit; LocalScheduler on local; CLI for manual). Callers of the core: local moka run | runner-command | moka next node/submit-result.
- createRun Hybrid: idempotent upsert. moka submit upserts createRun + persists schedule WHEN db.url is reachable (instant console pending); runner-lifecycle workflow.start upserts as the guaranteed in-cluster floor. Either/both safe.
- Resume: origin-default, per-node switchable. Local-origin run -> LocalScheduler continue (current); remote-origin -> re-submit an Argo workflow of only the not-yet-passed nodes. Nodes are independent, so a node's executor may be switched from the origin default.

Non-goals: rewriting Argo into a thin next-node driver loop (rejected Direction B); changing the live Pipeline Console event-sink stream (keep it for live UI; durable store is for persistence/replay).
<!-- SECTION:DESCRIPTION:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 All child tickets Done with per-criterion evidence
- [ ] #2 A submitted run is durable: createRun manifest + persisted schedule + every node's RuntimeNodeResult recorded; moka next node / status / resume operate on it
- [ ] #3 Exactly one DAG-stepping execution core (stepNode) with real callers in local run + runner-command + CLI; proven not an island
<!-- DOD:END -->
