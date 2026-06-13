---
description: Local multi-agent orchestrator — decompose a task and fan it out to the MoKa specialist roster on the current machine instead of submitting to the remote Moka pipeline. The local twin of the MoKa Orchestrator. On Claude Code, dispatch each agent with `opencode run`; on OpenCode, spawn native Task subagents. Use when the user wants parallel specialist agents driven locally rather than as Argo/k8s jobs.
name: orchestrate
---

# Orchestrate

The **local twin of the MoKa Orchestrator**. The MoKa Orchestrator decomposes a task and submits a schedule to Argo/k8s via `moka submit`, where the runtime executes it as DAG jobs on the cluster. Orchestrate runs the **same roster, same loop, on the current machine** — no schedule, no `moka submit`, no Argo. It is the hands-on, here-and-now path for getting work done through specialist agents.

Use this skill when the user wants real work driven through **parallel specialist agents locally**: a task large enough to decompose into research / test / implement / verify lanes, where you stay the controller and the agents do the labor.

## When NOT to use

- **Durable, reproducible, or cluster-scale runs** → use [[quick]] or [[execute]] (these submit through `moka submit`). Orchestrate is ephemeral and local; it leaves no schedule artifact.
- **Trivial single-threaded work** → just do it inline. Spawning agents for a one-line change is pure overhead.
- **You need package gates enforced as part of a pipeline run** → that is the remote path's job. Orchestrate still *uses* the gate agents (Verifier, Acceptance Reviewer) but does not replace pipeline-level gating.

## The roster

The same specialist agents the MoKa pipeline uses, mirrored locally. Each is `mode: all`, so it works both as an `opencode run --agent` subprocess and as a native Task subagent.

| Role        | Agent name              | Writes        | Job |
|-------------|-------------------------|---------------|-----|
| Research    | `MoKa Researcher`       | `research.json` only | Read-only; map the codebase, gather context, extract acceptance criteria. |
| Test        | `MoKa Test Writer`      | `*.test.ts` only | Write failing tests that describe the desired behaviour. |
| Implement   | `MoKa Code Writer`      | `src/**` only | Smallest production change that makes the failing tests pass. |
| Verify      | `MoKa Verifier`         | nothing       | Run checks, judge diff against AC, emit `PASS`/`FAIL` with evidence. |
| Review      | `MoKa Acceptance Reviewer` | nothing    | Acceptance/quality gate before declaring done. |
| Inspect     | `MoKa Inspector`        | nothing       | Read-only repository inspection / explanation. |

Keep each agent inside its lane — never ask the Code Writer to touch tests, or the Verifier to write files. The lane boundaries are what make fan-out safe.

## Dispatch by host

The orchestration **doctrine below is identical on every host**. Only the spawn mechanism differs — select the branch for the host you are actually running in.

### On Claude Code → `opencode run`

Spawn each roster member as a headless OpenCode subprocess and read its JSON back:

```sh
opencode run --agent "MoKa Code Writer" --format json \
  "<scoped task + acceptance criteria + paths to read>"
```

- Select the roster member with `--agent "<exact name>"` (names from the table above).
- Use `--format json` so the agent's structured result comes back machine-readable; parse it, do not eyeball it.
- **Parallelize independent lanes**: launch each `opencode run` as a background Bash process (one tool call per lane in the same turn), then collect. Run dependent lanes only after their inputs land.
- Pass context by path, not by paste — agents read the worktree directly. Hand them the files/AC the Researcher produced.
- `--model` / `--variant` only when a lane genuinely needs a different tier; otherwise inherit.

### On OpenCode → native Task subagents

You are already inside OpenCode — do not shell out to `opencode run`. Spawn the roster directly with the native **Task** tool, selecting the agent by the same name:

- `task` → `MoKa Researcher`, `MoKa Test Writer`, `MoKa Code Writer`, `MoKa Verifier`, `MoKa Acceptance Reviewer`.
- Issue independent Task calls together so they run concurrently; sequence dependent ones.
- Each subagent's structured output returns to you as the controller — gather, do not re-do their work.

## The loop

Whichever host you are on, run the same five steps:

1. **Plan** — Decompose the task into a DAG of agent lanes. Model parallelism *structurally*: independent lanes fan out together, dependents wait on their inputs (research → tests → implementation → verify). Do not invent JSON-pointer fanout; nest the work as real lanes.
2. **Dispatch** — Fan out per the host branch above. Scope each agent tightly: one job, its lane's write boundary, explicit acceptance criteria.
3. **Gather** — Collect each agent's structured output (`research.json`, the Verifier's verdict JSON, etc.). Treat the returned artifact as the source of truth.
4. **Gate** — Run `MoKa Verifier`, then `MoKa Acceptance Reviewer`. Do **not** accept work on a `FAIL`. Loop the relevant lane (re-dispatch Code Writer with the failure evidence) rather than papering over it.
5. **Synthesize** — Report only the evidence the agents actually returned: what passed, what the diff is, what the verifier proved. Never fabricate or assume an outcome an agent did not report.

## Rules

- **Doctrine is host-neutral; only the Dispatch section is host-specific.** Do not leak `opencode run` syntax into an OpenCode run or Task-tool talk into a Claude run.
- **You are the controller, not a worker.** Decompose, dispatch, gate, synthesize. Let the specialists do the labor inside their lanes.
- **Evidence only.** Report what agents returned. A green claim needs a Verifier `PASS` with evidence behind it — see [[verify]].
- **Respect lane write boundaries.** Researcher/Verifier/Reviewer write nothing; Test Writer touches only tests; Code Writer touches only `src/`. Mixed lanes corrupt parallel fan-out.
- **Local, not durable.** If the user needs a reproducible cluster run or a schedule artifact, route to [[quick]] / [[execute]] instead.

## The short version

Orchestrate is `moka submit` brought home: same roster, same decompose → dispatch → gather → gate → synthesize loop, run on this machine. On Claude Code each agent is an `opencode run --agent` subprocess; on OpenCode each is a native Task subagent. You stay the orchestrator — fan out the lanes, gate on real verifier evidence, and report only what the agents proved.
