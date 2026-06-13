# PIPE-81 — Hatchet Spike: Go/No-Go Decision

*2026-06-13 — synthesis of step-2 (Hatchet compiler, live cluster) + step-3 (Argo baseline) assessments*

## Verdict: **NO-GO.** Keep Argo. Execute the targeted cleanup (sequences 4–6) as planned.

The spike proved a moka DAG *can* run on Hatchet — compiled the real fixture through moka's own `compileScheduleArtifact`, translated `plan.topologicalOrder` to a Hatchet workflow, and ran it live on the cluster with correct dependency ordering, real parallelism, real command+gate execution, and correct gate-blocks-dependents behaviour (forced-failure run `189061dc…` showed the dependent task never started). That part is **S effort and works today.**

**But that is the wrong thing to optimize for.** The DAG graph is the part moka already has working and is *not* the source of the complexity the owner is frustrated by. The decision rides on what Hatchet does to everything wrapped *around* the graph — and there, the evidence is clearly against migration.

## Why no-go — the three load-bearing findings

### 1. Hatchet removes the isolation Argo gives for free
Argo runs **one pod per task**: process isolation, filesystem isolation, its own opencode, a clean worktree, plus a replayable git-ref commit history per node (`src/run-state/git-refs.ts`). Moka's planner literally has an `unsafeParallelWorktreeIssues` check *because* it relies on this.

Hatchet workers are **long-lived shared processes**; tasks are function calls multiplexed across worker slots. There is no pod-per-task. Concurrent agent tasks share filesystem, process space, and would share one opencode server unless re-engineered. Re-acquiring isolation means either rebuilding Argo's pod-per-step on top of Hatchet's queue (you've reinvented Argo, plus worker cold-start cost) or worktree-per-task in a shared worker (filesystem isolation only — a crashing agent takes down its siblings). **Cost: L, and it's buying back something we already have.**

### 2. The goal-loop has no Hatchet primitive — and we just invested in it
Moka's autonomy core re-prompts the *same opencode session* until a verdict passes (`OpencodeSessionRegistry`, enhanced 3 days ago in PIPE-73 to reuse sessions for full continuation context). Hatchet is a DAG of one-shot tasks with no "re-run this node with accumulated session state until a gate passes" concept. Rebuilding it = durable tasks + manual session-id threading + self-looping conditions — **a design project (L), not a translation.** Migrating would mean throwing away the PIPE-73 work we just landed and rebuilding it worse.

### 3. Gates and the console only partially survive
- **Gates:** moka has 7 gate kinds; only `command` collapses to "run argv, check exit". `verdict`/`acceptance`/`json_schema` parse the agent's structured output, `changed_files` reads moka's git-diff state, `artifact` checks the worktree — all depend on moka's `RuntimeContext`, which *is* the bulk of the runtime. Reimplementing 6 of 7 inside Hatchet task bodies: **M–L.**
- **Console:** Hatchet's dashboard genuinely replaces *raw* run-status / DAG-topology / per-task timing views (observed live). It does **not** replace moka's domain views — gate verdicts, acceptance-criteria coverage, goal-loop iteration, ticket association, the runner-event taxonomy. Net: partial replacement, so you keep a moka console anyway and add a second system. **Closing the gap: L–XL.**

**Total realistic migration: L–XL, dominated by isolation + goal-loop — not the graph.** That is a very large spend to replace a *working* execution layer with one that is worse at moka's specific needs (autonomy + isolation), in exchange for an orchestration graph moka already has.

## What the spike still changes (the wins we keep)

Two findings are worth banking even though we're not migrating:

1. **Argo's own UI already provides per-node timelines + log streaming.** This directly settles the open question in **PIPE-76**: the console should keep its *domain* views (gates, acceptance, tickets — which neither Argo nor Hatchet provide) and **deep-link to the Argo UI for raw run forensics** rather than reconstructing timelines from raw events. That deletes the heaviest, least-justified code in `runner-run-control.service.ts`.

2. **Kueue is confirmed "pure overhead for one user, but free when present"** (the label is a no-op on a bare cluster). This de-risks **PIPE-79**: removal is safe simplification, *keeping* it costs nothing at runtime. Lean toward removing for surface-area reduction, but it is not urgent.

## Adoption friction observed (would recur on any future re-evaluation)
- Bundled Postgres came up in `GMT`; Hatchet mis-times schedules unless forced to `UTC`.
- TS SDK defaults to TLS against an insecure gRPC endpoint (`HATCHET_CLIENT_TLS_STRATEGY=none` needed).
- `workflow.run()` (awaiting variant) **hung** even after all tasks completed; only `runNoWait()` + REST polling was reliable. The synchronous result API is not trustworthy as-is.

## Concrete plan (the keep-Argo path)

Sequences 4–6 proceed essentially **as written** — they are the right cleanup, and the spike *sharpens* two of them:

| Task | Status after verdict |
|---|---|
| **PIPE-72** (shared runner-event schema) | As written. Remove the "re-scope behind spike" caveat — it's a clean win, not migration-contingent. |
| **PIPE-74** (planner reorg: compile/generate) | As written. |
| **PIPE-75** (split the 1,848-line console route file) | As written. |
| **PIPE-76** (decompose run-control) | **Decision now made by the spike:** keep domain views, deep-link Argo UI for raw timelines, delete the timeline reconstruction. |
| **PIPE-79** (Kueue eval) | **Decision informed:** removal is safe + simplifying; keeping is zero-cost. Owner's call, low stakes. |
| **PIPE-80** (secrets consolidation) | As written (spike-independent). |

Plus the review's keep-Argo cleanup item: adopt **`@kubernetes-models/argo-workflows`** typed manifests in `argo-workflow.ts` to make the submit layer safer, and consider whether the dual planners (the *actual* complexity the owner feels) are addressed by PIPE-74 — they are, independent of execution engine.

**Bottom line:** the complexity the owner wants gone (dual planners, big files, the submit layer) is *orthogonal* to the execution engine and is addressed by the cleanup tasks. The execution engine itself (Argo) is the part that already works and earns its keep through isolation + native retry. Don't trade a working layer for an L–XL rebuild that's worse at moka's two hardest requirements.

## Spike teardown
Namespace `hatchet-spike` (8 pods) and port-forwards (PIDs 51502 engine, 51503 dashboard) **left intact** for owner inspection of the Hatchet dashboard (http://localhost:8080, admin@example.com / Admin123!!) before teardown. Teardown is one command: `helm uninstall hatchet-stack -n hatchet-spike && kubectl delete ns hatchet-spike` (plus `kill 51502 51503`). Nothing was committed to any repo; nothing touches ArgoCD.
