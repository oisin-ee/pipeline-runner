---
id: PIPE-81
title: 'Spike: Hatchet as unified execution engine (timeboxed go/no-go)'
status: To Do
assignee: []
created_date: '2026-06-12 20:11'
updated_date: '2026-06-12 20:21'
labels:
  - 'repo:pipeline'
  - 'repo:infra'
  - 'repo:console'
  - phase-4
  - spike
  - decision
dependencies:
  - PIPE-73
references:
  - report/architecture-review-2026-06-12.md
  - 'https://github.com/hatchet-dev/hatchet'
priority: high
ordinal: 12000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Timebox: 2 days. Decide whether Hatchet (hatchet-dev/hatchet — MIT, self-hosted Helm chart, Postgres-only, TS SDK with DAG workflows/retries/concurrency keys, built-in dashboard with run timelines) should replace the dual execution stack.

A "go" would delete: the local scheduler + retry + state store, the Argo compiler/submit layer (argo-workflow.ts, argo-submit.ts, argo-graph.ts), Kueue, the runner event sink, the console's SSE + sequence-replay machinery, and the console's run-timeline reconstruction. moka becomes "compile YAML DAG → Hatchet workflow"; quick mode = same engine with a local worker. Gates/hooks/goal-loop stay as plain task code either way.

Spike scope:
1. Deploy Hatchet on the k3s cluster (Helm, reuse existing Postgres or its bundled one).
2. Write a throwaway compiler: one real moka schedule YAML → Hatchet TS workflow (agent-node via opencode SDK, command-node, one gate, one parallel branch).
3. Run one real ticket end-to-end; compare against the same ticket via the Argo path.
4. Evaluate honestly: pod-per-agent isolation story (worker-in-container vs task-spawns-K8s-Job), dashboard sufficiency vs console, operational footprint, migration cost estimate.
5. Write a go/no-go decision doc in report/ with the deletion/migration plan (go) or the keep-Argo cleanup plan: @kubernetes-models/argo-workflows typed manifests + console leaning on Argo UI (no-go).

Run AFTER the contract-hardening tasks — clean contracts make either outcome cheap. Either answer is a win: adopt and delete ~40% of the system, or keep the custom stack knowing it earned its place.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Hatchet running on the cluster with one real ticket executed end-to-end through a compiled moka DAG (agent + command + gate + parallel)
- [ ] #2 Side-by-side notes vs the Argo path: isolation, observability, ops footprint, migration cost
- [ ] #3 Go/no-go decision doc committed to report/ with the concrete follow-up plan for whichever outcome
- [ ] #4 Spike infrastructure torn down or promoted deliberately — no zombie deployment left on the cluster
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Execution: THE task that earns the top model. Timebox 2 days regardless of model spend.
1. Hatchet deployment on k3s — model=sonnet (Helm install, follow docs).
2. Throwaway YAML→Hatchet compiler + end-to-end ticket run — model=fable or opus (novel integration, judgment calls about mapping node kinds/gates to Hatchet primitives).
3. Side-by-side comparison run via existing Argo path — model=sonnet (mechanical re-run + notes).
4. Go/no-go decision doc — model=fable (this single document steers ~40% of the system; it is the one place premium reasoning pays for itself).
Steps 2 and 3 parallelizable; 1 gates 2; 4 needs all.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Decision 2026-06-12 (Oisin): spike runs EARLY. Sole dependency is PIPE-73 (opencode SDK) — the description's 'run after contract hardening' paragraph is superseded. PIPE-72/74/75/76 are gated behind this spike's verdict so nothing potentially dead gets built first. Fast path: PIPE-71 → PIPE-73 → PIPE-81.
<!-- SECTION:NOTES:END -->
