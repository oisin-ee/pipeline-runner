---
id: PIPE-81
title: "Spike: Hatchet as unified execution engine (timeboxed go/no-go)"
status: Done
assignee: []
created_date: "2026-06-12 20:11"
updated_date: "2026-07-04 19:43"
labels:
  - "repo:pipeline"
  - "repo:infra"
  - "repo:console"
  - phase-4
  - spike
  - decision
dependencies:
  - PIPE-73
references:
  - report/architecture-review-2026-06-12.md
  - "https://github.com/hatchet-dev/hatchet"
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

- [x] #1 Hatchet running on the cluster with one real ticket executed end-to-end through a compiled moka DAG (agent + command + gate + parallel)
- [x] #2 Side-by-side notes vs the Argo path: isolation, observability, ops footprint, migration cost
- [x] #3 Go/no-go decision doc committed to report/ with the concrete follow-up plan for whichever outcome
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

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Spike concluded — verdict recorded. Grooming 2026-07-04.

**Decision doc committed**: report/hatchet-spike-go-no-go-2026-06-13.md at commit `66fb186` docs: Hatchet spike go/no-go verdict — NO-GO, keep Argo (PIPE-81).

**Verdict: NO-GO. Keep Argo.** The spike proved a moka DAG _can_ compile+run on Hatchet live on the k3s cluster (real dependency ordering, parallelism, command+gate execution, gate-blocks-dependents), so the graph itself is S-effort. But migration is L–XL and buys a worse execution layer, on three load-bearing findings:

1. Hatchet's long-lived shared workers remove the pod-per-task isolation Argo gives free (moka's planner relies on it via unsafeParallelWorktreeIssues).
2. The goal-loop (OpencodeSessionRegistry, just-invested PIPE-73 session reuse) has no Hatchet primitive — rebuild = design project.
3. Only 1 of 7 gate kinds collapses cleanly; console keeps its domain views regardless, so Hatchet adds a second system rather than replacing one.

**Acted upon**: the newest backlog epic PIPE-104 (yeet-backed opencode executor on Argo) confirms the keep-Argo path was taken. Spike also sharpened PIPE-76 (deep-link Argo UI for raw timelines) and PIPE-79 (Kueue removal safe/optional).

AC #1 (live end-to-end on cluster), #2 (side-by-side notes), #3 (committed decision doc) — satisfied. AC #4 (teardown / no zombie deployment): the doc deliberately LEFT namespace `hatchet-spike` intact for owner dashboard inspection, with a one-command teardown documented (`helm uninstall hatchet-stack -n hatchet-spike && kubectl delete ns hatchet-spike`; kill port-forward PIDs). ~3 weeks on, confirm on-cluster that `hatchet-spike` is gone — the only residual, and outside this repo's reach.

<!-- SECTION:FINAL_SUMMARY:END -->
