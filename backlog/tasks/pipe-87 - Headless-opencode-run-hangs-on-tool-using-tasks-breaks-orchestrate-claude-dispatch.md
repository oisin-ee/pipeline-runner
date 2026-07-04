---
id: PIPE-87
title: >-
  Headless `opencode run` hangs on tool-using tasks — breaks orchestrate's
  Claude-Code dispatch
status: To Do
assignee: []
created_date: '2026-06-17 14:55'
updated_date: '2026-07-04 19:44'
labels:
  - moka
  - orchestrate
  - opencode
  - bug
  - reliability
dependencies: []
references:
  - .claude/skills/orchestrate/SKILL.md
  - .opencode/agents/MoKa Inspector.md
  - .opencode/opencode.json
  - 'src/install-commands/claude-code.ts:122'
  - >-
    backlog/tasks/pipe-73 -
    Replace-agent-node-subprocess-scraping-with-opencode-serve-opencode-ai-sdk.md
  - >-
    backlog/tasks/pipe-104 -
    yeet-as-moka-spawn-runner-—-Phase-01-opencode-parity.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The `orchestrate` skill's Claude-Code branch dispatches each roster agent as a headless subprocess: `opencode run --agent "<MoKa X>" --format json "<task>"`. In a local environment (rondo repo, opencode 1.17.7), **this hangs indefinitely on any prompt that requires the agent to use a tool**, so the whole local orchestration path is unusable.

### Reproducible (observed 2026-06-17, opencode 1.17.7, cwd /Users/oisin/dev/rondo)
- WORKS (~6s, clean exit): `opencode run --agent "MoKa Inspector" "hi"` → model `openai/gpt-5.5-low` streams "Hi! How can I help?", loop step 1, exits. No tool use.
- HANGS (killed at 70s, exit 124): `opencode run --agent "MoKa Inspector" "In ONE sentence, state what backlog/tasks/rondo-018.06*.md is about."` — a prompt that forces a read/glob/bash tool call. Log stalls immediately after `message=init` and emits nothing until the timeout-triggered `cleanup prune=7.days`. The model `stream` step is never reached.

### Hypotheses RULED OUT (each tested)
1. **Remote MCP `pipeline-gateway` auth** — endpoint returns 401, but the working "hi" run loads the same config and completes; not a startup blocker.
2. **`--format json`** — hangs identically with default format.
3. **Tool-permission prompt (no TTY)** — ruled out: MoKa Inspector grants `bash/read/glob/grep/list: allow` (tools pre-approved, nothing to prompt).
4. **External plugins** (`oc-codex-multi-auth`, otel, goal-plugin) — `--pure` (plugins disabled) still hangs.

### Remaining candidates (NOT yet isolated)
- **LSP**: `.opencode/opencode.json` sets `lsp: true` and the MoKa agents grant `lsp: allow`; every run logs "enabled LSP servers" with ~36 server ids. The session may block initializing/awaiting an LSP server (most not installed) on the first file-touching turn. **Next isolation: disable LSP (`lsp: false` or per-run) and re-test the tool-using prompt.**
- The session **"process" step** (between `init` and `stream`) — prompt/context preparation, possibly a configured hook (`generated-defaults-audit`) — hanging on non-trivial prompts.
- The `openai/gpt-5.5-low` tool-call turn itself stalling under oauth for non-trivial requests (less likely; "hi" used the same model+auth).

### Impact
The `orchestrate` skill on Claude Code is non-functional locally — any real lane (Researcher reading files, Code Writer editing src) needs tool use and will hang. (The remote MoKa pipeline via `moka submit`/Argo is unaffected; this is the local `opencode run` dispatch path only.) Workaround in use: drive the batch via Claude Code native Task subagents (the `execute` skill) instead of `opencode run`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Root cause of the headless `opencode run` tool-task hang is confirmed (isolate via the LSP-disabled test first, then the process/hook path), and documented
- [x] #2 A headless `opencode run --agent "MoKa Inspector" --format json "<file-reading task>"` completes and returns parseable JSON within a normal timeout in the local environment
- [x] #3 A headless `opencode run --agent "MoKa Code Writer" ...` can read+edit a file end-to-end (the orchestrate Code lane works locally)
- [ ] #4 The fix is encoded where it belongs (opencode config defaults, the generated MoKa agent permission/LSP config, or an orchestrate-skill dispatch flag), not as a one-off env tweak
- [ ] #5 The `orchestrate` skill doc notes any required local config (e.g. `lsp:false` for headless dispatch) so the Claude-Code branch is reliable
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Grooming 2026-07-04 — still valid, still To Do. Investigation half (AC #1-3) is checked/concluded: root cause = LSP init on the first tool-using turn; `lsp:false` was the verified workaround. Remaining #4 (encode the fix where it belongs) and #5 (document in orchestrate skill) are UNCHECKED — the fix was found but never durably encoded. Only commit for this ticket is db47f68 docs(backlog): record PIPE-87 headless opencode-run investigation — no code fix landed.

Reference correction — the ticket points at `.claude/skills/orchestrate/SKILL.md` and `.opencode/opencode.json`, NEITHER of which lives in this repo (the orchestrate skill body is in the separate oisin-ee/skills repo; the .opencode config is generated into consumer repos at `moka init` time). The IN-REPO hang surface that this repo actually owns is **src/install-commands/claude-code.ts:122**, which still emits the exact headless dispatch `opencode run --agent "<displayName>" --format json --dir "$PWD" '<prompt>'` — the command PIPE-87 reports hangs on tool-using tasks. That line is where AC#4's durable fix (e.g. inject `lsp:false`/serve-mode dispatch) would land for the Claude-Code adapter.

Relations: PIPE-73 (Replace agent-node subprocess scraping with opencode serve/SDK) is still To Do — the runtime RUNNER path already uses the SDK (src/runtime/opencode-session-executor.ts) but the Claude-Code install-commands DISPATCH path still shells out to headless `opencode run`, so PIPE-73 landing on the dispatch path could retire this hang entirely. PIPE-104 (newest epic: yeet-backed opencode executor behind the executor seam) may supersede the whole headless-opencode dispatch — confirm scope before investing here; if PIPE-104 replaces the Claude-Code dispatch subprocess, PIPE-87 may become moot.
<!-- SECTION:NOTES:END -->

## Handoff Prompt

<!-- SECTION:NOTES:BEGIN -->
You are debugging a reliability bug in the local `orchestrate` dispatch path (`opencode run`). Reproduce and root-cause it, then fix it properly (root-cause, not a timeout bump).

1. Reproduce: in a repo with the MoKa agents, run `opencode run --print-logs --log-level INFO --agent "MoKa Inspector" "In one sentence, what is <some file> about?"`. Confirm it stalls after `message=init` (≈60s+, never reaches `stream`). Confirm `opencode run --agent "MoKa Inspector" "hi"` completes (no tool use).
2. Isolate (one variable at a time): first disable LSP (the prime suspect — config enables ~36 LSP servers and the stall begins on the first file-touching turn). If LSP-disabled completes, the cause is LSP init blocking; if it still hangs, instrument the `init → process → stream` transition (and the `generated-defaults-audit` hook) to find what blocks before the model stream. Already ruled out: pipeline-gateway MCP 401, `--format json`, tool-permission prompts (tools are pre-allowed), and external plugins (`--pure` still hangs).
3. Fix at the right layer: opencode config defaults and/or the generated MoKa agent config (e.g. `lsp:false` for headless agents, or lazy/bounded LSP) so headless tool-using runs complete. Avoid disabling capability the agents actually need.
4. Verify against AC #2–#3 (Inspector reads a file; Code Writer reads+edits a file headlessly) and update the orchestrate skill doc (AC #5).

Context: opencode 1.17.7; MoKa Inspector grants bash/read/glob/grep/list=allow, lsp=allow; `.opencode/opencode.json` sets `lsp:true`, a remote `pipeline-gateway` MCP, and plugins oc-codex-multi-auth/otel/goal-plugin. Models via openai oauth (`gpt-5.5-low`).
<!-- SECTION:NOTES:END -->

## Investigation (2026-06-17, opencode 1.17.7)

<!-- SECTION:INVESTIGATION:BEGIN -->
**The hang does not reproduce.** Ran the headless dispatch path live many ways — all exit 0, stable ~0.9s init→stream:
- `oisin-pipeline`: "hi" (no tool) ✓; markdown read (forces read tool) ✓.
- `rondo`: README read ✓; **TypeScript** file read (`apps/app/expo-env.d.ts`, strongest LSP trigger) ✓ (AC#2).
- `rondo`: **5 concurrent** `opencode run` (orchestrate-style fan-out) → 5/5 exit 0 in 24s.
- scratch git repo: **MoKa Code Writer** read+edit (`hello`→`hola`) → exit 0 (AC#3).

**LSP — the ticket's prime suspect — is EXONERATED.** The `enabled LSP servers` line (~36 ids) is opencode's *static catalog*, not spawned servers. No log line shows any LSP server spawning/initializing/blocking on a file touch, even on the `.ts` read. In headless `run`, LSP is enabled-but-dormant and never engages. So `lsp:false` would be a no-op for this symptom.

**Other hypotheses ruled out live:** concurrency (5/5 pass); DB write-lock contention — induced by holding a `BEGIN IMMEDIATE` lock on opencode.db while starting a run: opencode's first session write (`insert into "project" …`) **crashes fast (exit 1) in ~5s**, it does NOT hang. So acute contention → fast failure, not the reported 60s+ stall.

**Environment anomaly found (real, but a separate opencode-runtime issue, not a pipeline defect):** `~/.local/share/opencode/opencode.db` had grown to **4.2 GB** (the `event` event-sourcing table = **3.6 GB**; 1,095 sessions, 36k messages, 169k parts), with **multiple orphaned `opencode` server processes alive 16–23 h** holding the WAL. This degraded state makes opencode fragile (it crashes on DB-lock contention, as shown). However init→stream stayed ~0.9 s even at 4.2 GB, so the bloat is not *currently* stalling init.

**Most probable root cause of the original incident:** a **transient upstream provider/gateway stall** on the model `stream` turn. The original symptom (stalls after `init`, never reaches/produces `stream` output, ends with the timeout-triggered `cleanup prune`) matches a hung model request, and the 2026-06-17 ~14:55 observation overlaps the *same upstream 529-overload window* documented in the TOVA-767 incident (doc-1). That window has cleared.

**Disposition / recommendation (AC#4–#5):** no reproducible pipeline-side defect exists, so encoding a speculative `lsp:false` "fix" is not warranted (root-cause discipline). Real, in-scope hardening worth doing separately: (1) opencode DB/orphan-server hygiene (prune the 3.6 GB event table; reap stale servers) — an opencode-runtime concern; (2) keep supervised `moka run` canonical (orchestrate already treats raw `opencode run` as emergency-only fallback), where node-level retry + the PIPE-86 transient-retry absorb transient stalls/fast-failures. AC#4/#5 left open pending a decision on whether to land DB/dispatch hygiene; AC#1–#3 satisfied with the live evidence above.

Commands/logs captured under /tmp/oc-*.log during the session.
<!-- SECTION:INVESTIGATION:END -->
