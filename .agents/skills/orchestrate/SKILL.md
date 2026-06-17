---
description: Local multi-agent orchestration through the supervised MoKa runtime. Start canonical local work with `moka run "<task>"`; use OpenCode native Task subagents only when explicitly chosen; reserve emergency CLI fallback for titled, logged, session-captured recovery.
name: orchestrate
---

# Orchestrate

The **local supervised twin of the MoKa Orchestrator**. Start local orchestration with `moka run "<task>"` from the repository root. It uses the package-owned roster, config, run-control state, logs, and CLI contracts on the current machine — no raw host subprocess fan-out, no unmanaged local sessions.

Use this skill when the user wants real work driven through **parallel specialist agents locally**: a task large enough to decompose into research / test / implement / verify lanes, where you stay the controller and the agents do the labor through the supervised runtime.

## When NOT to use

- **Durable, reproducible, or cluster-scale runs** → use the remote path (for example `moka run --target remote ...` or the package compatibility commands). Orchestrate is local.
- **Trivial single-threaded work** → just do it inline. Spawning agents for a one-line change is pure overhead.
- **You need package gates enforced by a remote pipeline** → use the remote path. Local orchestration still uses the gate agents, but does not replace remote pipeline gating.

## The roster

The same specialist agents the MoKa pipeline uses, mirrored locally through package-owned config. When OpenCode native Task mode is explicitly chosen, select the same agent names.

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

Keep each agent inside its lane — never ask the Code Writer to touch tests, or a reviewer to write files. The lane boundaries are what make fan-out safe. (`MoKa Schedule Planner` is intentionally **not** in this roster: it plans remote DAGs; locally *you* decompose before dispatch.)

## Dispatch

The orchestration doctrine is host-neutral: **canonical local orchestration starts with `moka run`**. Host-specific dispatch applies only when the user explicitly chooses OpenCode native Task use or when supervised CLI execution is unavailable and an emergency fallback is accepted.

### Canonical supervised local run — all hosts

```sh
moka run "<scoped task + acceptance criteria + paths to read>"
```

- Start here on Claude Code, OpenCode, and plain terminals. Do not pair this with unmanaged local subprocess fan-out for the same work.
- Use package flags instead of host-specific spawning: `--effort quick`, `--effort thorough`, `--read-only`, `--detach`, or `--target remote` when those modes are intended.
- Capture the `Run id` and inspect with `moka status <run-id>` and `moka logs <run-id>` rather than relying on an agent transcript alone.
- If you manually split lanes, keep each lane as its own supervised run with tight scope and explicit acceptance criteria.

### Explicit OpenCode native Task mode

Use this branch only when the user explicitly chooses native OpenCode Task subagents and you are already inside OpenCode.

- Spawn the roster directly with the native **Task** tool, selecting the agent by the exact name from the table.
- Issue independent Task calls together so they run concurrently; sequence dependent ones.
- Each subagent's structured output returns to you as the controller — gather it, do not re-do their work.
- Do not shell out from OpenCode for local orchestration; if the supervised CLI is available, return to `moka run`.

### Emergency fallback — raw `opencode run`

Use raw `opencode run` only when `moka run` cannot execute, the user still wants local agent work, and you explicitly record that the run is outside MoKa supervision.

```sh
mkdir -p .pipeline/runs
title="Emergency fallback: <lane>"
log=".pipeline/runs/emergency-$(date +%Y%m%d%H%M%S).log"
opencode run --agent "MoKa Code Writer" --format json \
  "<scoped task + acceptance criteria + paths to read>" 2>&1 | tee "$log"
```

- Required capture: fallback title, exact command, cwd, log path, and session id from the output/event stream. If no session id is emitted, state that explicitly.
- Keep the fallback lane scoped and one-shot; switch back to `moka run` as soon as the supervised runtime is available.

## The loop

Whichever allowed dispatch path you use, run the same six steps:

1. **Plan** — Decompose the task into a DAG of agent lanes. Model parallelism *structurally*: independent lanes fan out together, dependents wait on their inputs (research → tests → implementation → verify). Do not invent JSON-pointer fanout; nest the work as real lanes.
2. **Dispatch** — Prefer `moka run`; use native Task only when explicitly chosen; use emergency fallback only with the required capture above. Scope each agent tightly: one job, its lane's write boundary, explicit acceptance criteria.
3. **Gather** — Collect each agent's structured output (`research.json`, the Verifier's verdict JSON, etc.). Treat the returned artifact as the source of truth.
4. **Gate** — Run `MoKa Verifier` (checks vs AC), `MoKa Acceptance Reviewer` (audits each acceptance criterion), and `MoKa Thermo Nuclear Reviewer` (final code-quality review). Do **not** accept work on a `FAIL` from any gate. Loop the relevant lane with the failure evidence rather than papering over it.
5. **Learn** — Once the gates pass, run `MoKa Learner` to store durable lessons from the run (qdrant memory) when there is something worth reusing. This mirrors the canonical pipeline's LEARN phase; skip it only when the run produced nothing reusable.
6. **Synthesize** — Report only the evidence the agents actually returned: what passed, what the diff is, what the reviewers proved. Never fabricate or assume an outcome an agent did not report.

## Task sizing, reliability & token budget

Token usage is the dominant cost and quality lever — it explains the bulk of agent performance variance, and context degrades well before a model's window fills. But the first job of sizing is **reliable completion**: a lane an agent can't finish is worthless however cheap. Size the work accordingly:

- **Size for reliable completion first.** Each lane must be small enough that a single agent session finishes it cleanly. If an agent times out, stalls, or returns having only *planned* without producing its artifact, the lane was **too big** — split it into smaller lanes (one file, section, or concern each); do **not** just raise the timeout, that re-runs the same flake. **Slow is fine; flaky is not** — many small lanes that each reliably complete beat one big lane that gambles. Lanes that share a file run sequentially; only truly independent lanes fan out. Treat repeated stalls as a decomposition bug, not bad luck.
- **Under-timeouts and permission walls are the real flake sources.** Give long multi-file authoring runs generous wall-clock, scope lanes so they don't need denied/external reads, and only bound runaway agents when you genuinely need a hard limit. Smaller lanes still help (less work = faster, fewer surprises), but "multi-file authoring can't be delegated" is usually a timeout/scoping issue.
- **Scale fan-out to complexity, not ambition.** A trivial change is one agent (or just do it inline); a bounded change is 1–3 lanes; only go wide for genuinely independent breadth. Code parallelizes poorly — keep writer lanes narrow.
- **Keep each agent's context small and high-signal.** Pass context by path and hand over the distilled `research.json`, never raw repo dumps. A lane that needs half the repo in its context is mis-scoped — split it.
- **Distilled returns.** Expect each sub-agent to return a ~1–2k-token summary of its result, not its full transcript. Gather the summary; don't re-read the work.
- **Re-dispatch once, with evidence.** On a gate `FAIL`, re-dispatch the failing lane a *single* time with concentrated failure evidence — do not thrash. Each fresh supervised lane pays the cold-start context cost; fix the input, not the dice.
- **Smallest roster that covers the work.** Every extra lane is another cold standup. Default to the fewest specialists that close the task; add a lane only when it genuinely runs independently.

## Rules

- **Canonical local orchestration starts with `moka run`.** Do not tell Claude Code to use `moka run` and also spawn unmanaged subprocesses.
- **Host distinction is opt-in.** OpenCode native Task subagents are valid only when explicitly chosen; otherwise use the supervised CLI.
- **Emergency fallback is not canonical.** Raw host CLI use requires the title/log/session capture above and must be reported as unsupervised.
- **You are the controller, not a worker.** Decompose, dispatch, gate, synthesize. Let the specialists do the labor inside their lanes.
- **Evidence only.** Report what agents returned. A green claim needs a Verifier `PASS` with evidence behind it — see [[verify]].
- **Respect lane write boundaries.** Researcher/Verifier/both Reviewers write no repo files (Researcher emits only `research.json`; Learner writes only to memory); Test Writer touches only tests; Code Writer touches only `src/`. Mixed lanes corrupt parallel fan-out.

## The short version

Start local orchestration with `moka run "<task>"`. Use OpenCode native Task subagents only when explicitly chosen, and use emergency raw CLI fallback only with title, log, and session capture. You stay the orchestrator — decompose the lanes, gate on real verifier *and* reviewer evidence, capture lessons via the Learner, and report only what the agents proved.
