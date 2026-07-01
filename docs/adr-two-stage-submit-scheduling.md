# ADR: Two-Stage `moka submit` — Schedule-Then-Dispatch

Status: Accepted

Date: 2026-07-01

## Decision

`moka submit` is one flow with two stages, not two separate commands and not two
separate code paths:

1. **Schedule** — research, planning, and graph generation, producing a
   `ScheduleArtifact` and persisting it to the durable Postgres run-control
   store before any Argo Workflow exists.
2. **Dispatch** — compile the persisted (or explicitly supplied) schedule into
   an Argo Workflow manifest and submit it, targeting whatever Kubernetes
   cluster/context the operator configured.

Both stages run inside the single call chain:

```
moka submit [args]
  -> registerSubmitCommand()            src/cli/program.ts:71
  -> runMokaSubmitFromCli()             src/cli/submit-options.ts:55
  -> submitMoka()                       src/moka-submit.ts:238
  -> submitParsedMoka()                 src/remote/submit/service.ts:47
       - compileMokaSubmitPlan()        src/remote/submit/compilation.ts:32
       - upsertRunRecord()  [Schedule -> DB]
       - submitCompiledMokaWorkflow()   src/remote/submit/argo-submission.ts:46  [Dispatch]
```

There is exactly one WorkflowSpec builder chain (`buildRunnerArgoWorkflowManifest`
/ `buildDynamicRunnerArgoWorkflowManifest` in `src/argo-workflow.ts`) and exactly
one Kubernetes/Argo client (`KubernetesArgoService` in
`src/runtime/services/kubernetes-argo-service.ts`). Static and dynamic
scheduling are a discriminated union (`dynamicScheduling: boolean` on
`CompiledMokaSubmitPlan`), not parallel implementations.

## Stage 1 — Schedule (research -> planning -> graph, persisted)

When no `scheduleYaml`/`schedulePath` is supplied at submit time
(`dynamicScheduling: true`), the schedule is produced inside the runner pod by
three sequential phases, run via `moka runner-pre-schedule --phase <phase>`
(`src/runner-command/pre-schedule.ts`):

1. `pre-research` — produces research context (findings, risks, target).
2. `pre-planning` — consumes research, produces a `TicketPlan` (tickets +
   dependencies), via `ticketPlanPlanningContext()`
   (`src/planning/generate.ts:343`).
3. `generate-schedule` — calls the configured planner profile to produce the
   final `ScheduleArtifact`. If the planner fails or emits an invalid
   artifact, `ticketPlanScheduleArtifact()` (`src/planning/generate.ts:497`)
   deterministically derives a schedule directly from the `TicketPlan` graph
   instead — this is the accepted fallback shape, not a patch to remove.

The result is written once via `publishSchedule()`
(`src/run-control/run-control-store.ts:60`) into the run's manifest
(`moka_run_control_run.manifest` JSONB). `publishSchedule` is idempotent for an
identical schedule and rejects a conflicting one for the same run
(`tests/run-control-store-contract.test.ts:423`).

## Stage 2 — Dispatch (compile -> submit)

`submitParsedMoka()` (`src/remote/submit/service.ts:47`) upserts the run record
to Postgres **before** calling Argo, but a DB write failure never blocks
dispatch — the guard at `service.ts:56-61` logs and proceeds, because the
in-pod runner lifecycle (`src/runner-command/lifecycle.ts`) re-creates the same
run record idempotently once the pod starts. Postgres is a durability/inspection
substrate for `moka status`/`moka logs`/`moka resume`, not a precondition for
submission.

`submitCompiledMokaWorkflow()` then calls `submitRunnerArgoWorkflow()` (static,
schedule already known) or `submitDynamicRunnerArgoWorkflow()` (dynamic,
schedule generated in-pod) — both in `src/argo-submit.ts`, both routed through
the same `KubernetesArgoService`.

## Cluster targeting is one seam, not per-caller

Kubernetes context/kubeconfig resolution is a single function,
`resolveKubeConfig()` (`src/runtime/services/kubernetes-argo-service.ts`), used
by every Argo/K8s call (`createConfigMap`, `createWorkflow`,
`getWorkflowPhase`). Precedence, highest wins:

1. `--kube-context <name>` / `--kubeconfig <path>` CLI flags
   (`src/cli/submit-options.ts`)
2. `momokaya.kubernetes.context` / `momokaya.kubernetes.kubeconfig` in
   `~/.config/moka/config.yaml` (`src/moka-global-config.ts`)
3. The kubeconfig's own `current-context` (`KubeConfig.loadFromDefault()`)

An unresolvable `kubeContext` fails loud at resolution time (`kubeConfig.
getContextObject()` check) rather than silently falling through to whatever
context happened to be current — this is what makes "point submit at momokaya
or at a local orbstack context" a config change, never a code change. Prior to
this ADR, `kubeContext` existed for the `kubectl`-shellout polling path
(`cluster-doctor.ts`) but not for the actual submission API calls; that gap is
closed as part of this decision.

## Consequences

- Do not add a second "generate the graph" path or a second Argo client.
  Static vs. dynamic scheduling is a data flag on `CompiledMokaSubmitPlan`, not
  a reason to fork the builder or the service.
- Do not gate submission on the DB write succeeding — the guard in
  `service.ts` is intentional, not a missing try/catch to "fix".
- Any new cluster-targeting option (a third context source, a per-namespace
  override) is added to `resolveKubeConfig`'s precedence list, not threaded
  ad hoc through individual call sites.

## References

- Run-control persistence model: `./run-control.md`
- PIPE-94 durable substrate: `oisin-ee` backlog PIPE-94.3/94.4/94.5/94.8
