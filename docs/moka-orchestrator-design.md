# moka as orchestrator — durable state authority + refusable gate

Status: design (grilled 2026-06-26). Layer B durable substrate and debug
node-stepping are implemented for generated schedules, run-control manifests,
durable node results, `moka next node`, `moka submit-result`, and `moka resume`.

## Thesis

moka becomes the central durable state authority and mechanical gate for agent work. A guarded, persisted state machine is the source of truth; the executing agent is an **untrusted worker** that can only advance work by satisfying moka, and moka can **refuse a transition with structured reasons**. Robustness (completion can't be vibed past), debuggability (every transition is a recorded call with structured in/out), and replayability fall out of this shape.

## Glossary

- **Schedule** — the unit of work. A request compiles to a schedule (a DAG of nodes); work scales by schedule _size_, not by architecture. Small task → small schedule; epic → large nested schedule.
- **Ticket** — one entrypoint that compiles to a schedule. `moka ticket complete` adjudicates that schedule's terminal success gate.
- **Wave** — a static topological layer of the DAG, and the unit of expansion. Execution proceeds wave by wave.
- **Node-execution protocol** — the executor-agnostic contract between moka and whatever runs a node (a moka-spawned agent, or an external/human caller in debug). Input: prompt + criteria + upstream outputs. Output: a `RuntimeNodeResult`.
- **Terminal success gate** — the recursive gate at the end of every workflow (root or nested `kind: workflow`). A sub-workflow node passes iff its sub-schedule's terminal gate passes.
- **Structured refusal** — a gate result of shape `{ passed, unmet: [{ criterion, reason, evidence }] }` (OPA `deny`-set shape), not a bare boolean. Refusal must be actionable.
- **Re-plan escalation** — the bounded, exceptional path that appends a wave when a node fails its gate after its retry budget.

## Locked decisions

1. **Control model — one architecture, pluggable executor.** moka owns schedule + state + gates. Default transport: moka spawns the agent per node. Debug transport: an external caller / human steps a node via `moka next node` / submit-result. Both speak the same node-execution protocol, so it is one architecture with a pluggable executor, not two. The seam already exists: `runNode: (nodeId) => Promise<RuntimeNodeResult>` in `src/runtime/scheduler.ts`. Production = spawn-and-run plug; debug = pause-and-await-submit plug; identical `RuntimeNodeResult` contract.

2. **Unit of work = the schedule.** A ticket is one entrypoint that compiles to a schedule; `moka ticket complete` = that schedule's terminal success gate. The refusal contract is **recursive** — every workflow has a terminal success-payload gate; nesting composes.

3. **Graph = wave-based hybrid.** Static DAG within a wave (deterministic, replayable); waves are the topological layers. Planning happens **once** up front (one-shot pre-phase → full multi-wave schedule). No recurring planner node.

4. **Re-plan = exceptional, not routine.** Default run: zero re-plans. Trigger: gate-failure-after-retry-budget escalates to a single bounded re-plan that appends a wave. An agent `needs-replan` discovery-signal is allowed but **capped and planner-adjudicated** (never agent-self-served). Hard max-replan cap.

5. **Gate adjudication = layered**, in order: (1) **deterministic** (tests / typecheck / lint / build / schema-validate / file-exists — existing `command` / `builtin` / `json_schema` / `artifact` gate kinds); (2) **typed structured-claim** completeness; (3) **LLM-judge only** for the un-encodable residue, **anchored to deterministic evidence, never standalone** (LLM-judge is empirically gameable).

6. **Refusal is structured, not binary.** Extend the gate result from `{ passed: boolean, reason? }` to `{ passed, unmet: [{ criterion, reason, evidence }] }`. Uninterpretable feedback makes the agent spin to max retries.

7. **Criteria are read-only to the executing agent.** Acceptance criteria and their adjudicating tests are owned by the schedule / planner, never writable by the node's agent (anti reward-hacking; SWE-bench hides test patches for this reason).

8. **Durable substrate = cluster Postgres, one store, URL as a setting.** A `db.url` setting in moka config (alongside `~/.config/moka/config.yaml`) points at the cluster Postgres; local debug points the same setting at the cluster (or a local PG / tunnel). One DB type, no sqlite, no Turso, no sync layer. This replaces the former ephemeral per-run JSONL journal (`src/runtime/run-journal.ts`): record inputs + outputs + criteria, keyed by `(runId, nodeId)`, queryable and resumable across invocations. The Effect scheduler stays (one-engine consolidation intact) — borrow _persistence_ (`pg` / `postgres.js` + Drizzle/Kysely for migrations), not an orchestration engine. Steal DBOS's ideas (step-keyed checkpoints, record-inputs-for-deterministic-re-run), not its engine.

## Phasing

- **Layer A first** — `moka ticket complete` as a refusable gate with structured reasons. Roughly 70% built on existing gates (`src/runtime/gates/gates.ts`) and acceptance-criteria storage (`src/tickets/backlog-task-store.ts`). Smallest blast radius, biggest robustness win. Prove on real work.
- **Layer B** — the Postgres durable substrate + CLI stepping (`moka next node`, `moka submit-result`, resume) that makes moka own the cross-invocation loop. Implemented: `momokaya.db.url` selects the DB substrate, generated schedules are persisted as `manifest.schedule`, durable node results are keyed by `(runId, nodeId)`, `moka next node <runId>` reads the schedule from DB state, and `moka resume <runId>` rebuilds the graph from the persisted schedule.

## Durable submitted-run flow (Layer B — PIPE-94)

### Submitted-run creation

`moka submit` (`moka run --target remote`) launches an Argo Workflow AND, when `db.url` is reachable, upserts the run into the RunControlStore via `store.createRun`. The in-pod `runner-lifecycle workflow.start` phase is the guaranteed in-cluster floor: it calls the same `buildRemoteRunCreateRequest` builder to upsert `createRun` with the schedule and the complete node list (`src/runner-command/lifecycle.ts`). `createRun` is idempotent first-writer-wins (`ON CONFLICT DO NOTHING`), so submit + lifecycle both calling it is safe — whichever wins first persists a complete manifest. Each runner pod resolves `db.url` from the `MOKA_DB_URL` environment variable, injected as a `secretKeyRef` from the secret named in `momokaya.submit.dbAuth`. When `MOKA_DB_URL` is absent, `runner-lifecycle` logs the skip and the run proceeds without durable substrate.

### Per-node result persistence

`runner-command` records each node's `RuntimeNodeResult` through the shared step-node core (`src/runtime/step/step-node.ts`) via `recordNodeResult`, keyed `(runId, nodeId)`. The RunControlStore receives a matching node-status projection via the wrapped runtime reporter. This makes `moka next node`, `moka status`, and `moka resume` fully operational on a submitted run. Git node-refs (file-state handoff via `src/run-state/git-refs.ts`) and the Pipeline Console event-sink stream are unchanged; the durable store is additive on top of both.

### One stepping engine

There is a single DAG-stepping execution core at `src/runtime/step/step-node.ts`. `recordNodeResult` is the single terminal-result write path, with three real callers:

- **Local `moka run`** — via `buildRunJournal` in `src/runtime/run-journal.ts`.
- **Argo runner (`runner-command`)** — via `recordDurableNodeResultEffect` in `src/runner-command/run.ts`.
- **`moka next node` / `submit-result` CLI** — via `src/run-control/submit-result.ts`.

No parallel stepping path exists; all executors converge on the same `(runId, nodeId)` record.

### Resume semantics

`moka resume <runId>` dispatches on the run's origin (`manifest.target`, resolved in `src/pipeline-runtime.ts`):

- **local** — continues on the LocalScheduler in-process; current behaviour, byte-identical.
- **remote** — re-submits the persisted schedule to Argo under the same `runId` (so `createRun` stays idempotent and progress is preserved). Each runner pod's `skipAlreadyPassedNodeEffect` checks the durable store first and no-ops any node already recorded PASSED — re-submitting the full graph only executes the remaining nodes; passed nodes' git refs already exist. The `forceRerunNodeIds` runner-command payload field overrides the skip to re-execute a specific already-passed node.

When `db.url` is absent, `moka resume` falls back to the local path, where the missing durable store surfaces a clear error.

## Module layout (Layer A)

Everything evolves as deep modules following the existing `src/runtime/<capability>/{<name>.ts, <name>.test.ts, index.ts}` convention. The SHAPE fix is a data-driven gate registry replacing the `switch (gate.kind)` branch ladder in `gates.ts`, so new gate kinds become drop-in modules rather than new switch arms.

```
src/runtime/gates/
  index.ts            # public surface: evaluateNodeGates(), kind registration
  registry.ts         # Record<GateKind, GateEvaluator>  (replaces switch(gate.kind))
  orchestrator.ts     # eval loop + observability (extracted from gates.ts)
  contract.ts         # GateEvaluator type + GateVerdict aggregate
  kinds/
    command/ artifact/ builtin/ verdict/ acceptance/ changed-files/ json-schema/   # 7 existing, extracted
    structured-claim/   # new: per-criterion evidence completeness
    llm-judge/          # new: evidence-anchored residue judge
  adjudicator/        # adjudicate(criteria, claim, attempt) -> GateVerdict{passed, unmet[]}

src/tickets/completion/        # complete-ticket use-case (load criteria -> adjudicate -> Done | refuse)
src/commands/ticket/           # 725-line ticket-command.ts split into per-subcommand modules + registry
```

Refusal type: extend `RuntimeGateResult.unmet[]` in `contracts/contracts.ts` (shared hub); `GateVerdict` in the gate module's surface.

Ticket graph (PIPE-90): 90.1 refusal contract -> 90.2 registry seam -> {90.6 extract 7 kinds, 90.7 structured-claim, 90.8 llm-judge} -> 90.10 adjudicator -> 90.11 completion + command; 90.5 spec and 90.9 ticket-command split run independently. The registry seam parallelizes the two new kinds (separate module dirs, registered in the adjudicator step, no shared-file collision).

## Open risks (not yet designed)

- **DoD authoring is the make-or-break.** SWE-bench Verified culled 68% of hand-written specs as unadjudicatable. Most prose acceptance criteria are not machine-checkable. The planner producing _good_ layered criteria matters more than the gate mechanism.
- **Re-plan loop safety** — the cap needs concrete numbers and a terminal human-escalation state, not infinite re-drive.
- **Node-execution protocol evolution** — the first JSON contract is implemented: `moka next node <runId>` emits `{ runId, nodeId, prompt, criteria, upstreamOutputs }`, and `moka submit-result <runId> <nodeId> --json <RuntimeNodeResult>` persists the terminal node result. Future design work is limited to protocol extensions, not the base shape.

## Prior-art landscape (research 2026-06-26)

- Durable engines: Temporal (MIT, most battle-tested), Restate (BSL), DBOS (MIT, best step-replay debugger), Inngest (SSPL). None ships "engine refuses to advance until acceptance criteria met, LLM worker untrusted" as a primitive.
- Refusal-with-reasons contract: OPA (`deny`-set with reasons, decision logs). State-machine-refuses-transition: Symfony Workflow (guards as authorization checks, blockers carry reasons).
- Closest control loop: LangGraph `interrupt()` / checkpointer (pause-persist-await-external-decision-resume). Closest single completion gate: CrewAI guardrails (`(False, error)` → bounded retry).
- Empirical backing: "LLMs Cannot Self-Correct Reasoning Yet" (arXiv 2310.01798) — external feedback required; "One Token to Fool LLM-as-a-Judge" (arXiv 2507.08794) — LLM-judge gameable.

moka's novelty is the **union** of these precedented pieces, not any single one.
