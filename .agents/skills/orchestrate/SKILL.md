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
- **You need package gates enforced as part of a pipeline run** → that is the remote path's job. Orchestrate still *uses* the gate agents (Verifier, Acceptance Reviewer, Thermo Nuclear Reviewer) but does not replace pipeline-level gating.

## The roster

The same specialist agents the MoKa pipeline uses, mirrored locally. Each is `mode: all`, so it works both as an `opencode run --agent` subprocess and as a native Task subagent.

| Role        | Agent name              | Writes        | Job |
|-------------|-------------------------|---------------|-----|
| Research    | `MoKa Researcher`       | `research.json` only | Read-only; map the codebase, gather context, extract acceptance criteria. |
| Test        | `MoKa Test Writer`      | `*.test.ts` only | Write failing tests that describe the desired behaviour. |
| Implement   | `MoKa Code Writer`      | `src/**` only | Smallest production change that makes the failing tests pass. |
| Verify      | `MoKa Verifier`         | nothing       | Run checks, judge the diff against AC, emit `PASS`/`FAIL` with evidence. |
| Acceptance  | `MoKa Acceptance Reviewer` | nothing    | Audit the change against each acceptance criterion; `PASS`/`FAIL` with evidence. |
| Code review | `MoKa Thermo Nuclear Reviewer` | nothing | Final code-quality review of the integrated change — the heavyweight reviewer, distinct from the AC audit. |
| Learn       | `MoKa Learner`          | memory only   | Store durable lessons from the completed run (qdrant memory). The pipeline's LEARN phase. |
| Inspect     | `MoKa Inspector`        | nothing       | Read-only repository inspection / explanation. |

Keep each agent inside its lane — never ask the Code Writer to touch tests, or a reviewer to write files. The lane boundaries are what make fan-out safe. (`MoKa Schedule Planner` is intentionally **not** in this roster: it plans the DAG for remote `moka submit`; locally *you* do that in the Plan step.)

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

- `task` → `MoKa Researcher`, `MoKa Test Writer`, `MoKa Code Writer`, `MoKa Verifier`, `MoKa Acceptance Reviewer`, `MoKa Thermo Nuclear Reviewer`, `MoKa Learner`.
- Issue independent Task calls together so they run concurrently; sequence dependent ones.
- Each subagent's structured output returns to you as the controller — gather, do not re-do their work.

## The loop

Whichever host you are on, run the same six steps:

1. **Plan** — Decompose the task into a DAG of agent lanes. Model parallelism *structurally*: independent lanes fan out together, dependents wait on their inputs (research → tests → implementation → verify). Do not invent JSON-pointer fanout; nest the work as real lanes.
2. **Dispatch** — Fan out per the host branch above. Scope each agent tightly: one job, its lane's write boundary, explicit acceptance criteria.
3. **Gather** — Collect each agent's structured output (`research.json`, the Verifier's verdict JSON, etc.). Treat the returned artifact as the source of truth.
4. **Gate** — Run `MoKa Verifier` (checks vs AC), `MoKa Acceptance Reviewer` (audits each acceptance criterion), and `MoKa Thermo Nuclear Reviewer` (final code-quality review). Do **not** accept work on a `FAIL` from any gate. Loop the relevant lane (re-dispatch Code Writer with the failure evidence) rather than papering over it.
5. **Learn** — Once the gates pass, run `MoKa Learner` to store durable lessons from the run (qdrant memory) when there is something worth reusing. This mirrors the canonical pipeline's LEARN phase; skip it only when the run produced nothing reusable.
6. **Synthesize** — Report only the evidence the agents actually returned: what passed, what the diff is, what the reviewers proved. Never fabricate or assume an outcome an agent did not report.

## Task sizing, reliability & token budget

Token usage is the dominant cost and quality lever — it explains the bulk of agent performance variance, and context degrades well before a model's window fills. But the first job of sizing is **reliable completion**: a lane an agent can't finish is worthless however cheap. Size the work accordingly:

- **Size for reliable completion first.** Each lane must be small enough that a single agent session finishes it cleanly. If an agent times out, stalls, or returns having only *planned* without producing its artifact, the lane was **too big** — split it into smaller lanes (one file, section, or concern each); do **not** just raise the timeout, that re-runs the same flake. **Slow is fine; flaky is not** — many small lanes that each reliably complete beat one big lane that gambles. Lanes that share a file run sequentially; only truly independent lanes fan out. Treat repeated stalls as a decomposition bug, not bad luck.
- **The opencode step budget is a hard cap — author multi-file changes inline or in one-file lanes.** Each `opencode run` agent has a fixed step/turn budget and **there is no flag or config to raise it**. Read-only lanes (Researcher, Inspector) finish comfortably within it and delegate *reliably*. But a Code Writer asked to author across many files burns the whole budget on exploration and gets **cut off before writing a single file** — the run "succeeds" having only planned. So do **not** delegate broad multi-file authoring (scaffolding, chart-ification, a whole redesign) as one Code Writer run. Either **author it inline** (you, the controller — the reliable path for sprawling edits), or split it into lanes scoped to a **single file or concern**, each small enough that explore-plus-write fits the budget. Delegation is strongest for research, review, verification, and tightly-scoped single-file edits — not sprawling authoring.
- **Scale fan-out to complexity, not ambition.** A trivial change is one agent (or just do it inline); a bounded change is 1–3 lanes; only go wide for genuinely independent breadth. Code parallelizes poorly — keep writer lanes narrow (the pipeline caps `green`/code fan-out at 2 for exactly this reason).
- **Keep each agent's context small and high-signal.** Pass context by path and hand over the distilled `research.json`, never raw repo dumps. A lane that needs half the repo in its context is mis-scoped — split it.
- **Distilled returns.** Expect each sub-agent to return a ~1–2k-token summary of its result, not its full transcript. Gather the summary; don't re-read the work.
- **Re-dispatch once, with evidence.** On a gate `FAIL`, re-dispatch the failing lane a *single* time with concentrated failure evidence — do not thrash. Each fresh `opencode run` re-pays the full cold-start context tax (~35k tokens of standup before any work), so a retry loop is expensive; fix the input, not the dice.
- **Smallest roster that covers the work.** Every extra lane is another cold standup. Default to the fewest specialists that close the task; add a lane only when it genuinely runs independently.

## Rules

- **Doctrine is host-neutral; only the Dispatch section is host-specific.** Do not leak `opencode run` syntax into an OpenCode run or Task-tool talk into a Claude run.
- **You are the controller, not a worker.** Decompose, dispatch, gate, synthesize. Let the specialists do the labor inside their lanes.
- **Evidence only.** Report what agents returned. A green claim needs a Verifier `PASS` with evidence behind it — see [[verify]].
- **Respect lane write boundaries.** Researcher/Verifier/both Reviewers write no repo files (Researcher emits only `research.json`; Learner writes only to memory); Test Writer touches only tests; Code Writer touches only `src/`. Mixed lanes corrupt parallel fan-out.
- **Local, not durable.** If the user needs a reproducible cluster run or a schedule artifact, route to [[quick]] / [[execute]] instead.

## The short version

Orchestrate is `moka submit` brought home: same roster, same decompose → dispatch → gather → gate → learn → synthesize loop, run on this machine. On Claude Code each agent is an `opencode run --agent` subprocess; on OpenCode each is a native Task subagent. You stay the orchestrator — fan out the lanes, gate on real verifier *and* reviewer evidence, capture lessons via the Learner, and report only what the agents proved.
