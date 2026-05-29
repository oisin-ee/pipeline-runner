---
id: PIPE-31.7
title: 'install-commands: one slash command per configured entrypoint (every host)'
status: Done
assignee: []
created_date: '2026-05-28 17:45'
updated_date: '2026-05-28 21:27'
labels:
  - drain
  - install-commands
milestone: m-0
dependencies:
  - PIPE-31.5
references:
  - /Users/oisin/.claude/plans/right-now-we-have-parallel-abelson.md
  - 'src/install-commands.ts:440'
  - 'src/install-commands.ts:502'
  - 'src/install-commands.ts:571'
  - 'src/install-commands.ts:681'
  - 'src/install-commands.ts:864'
  - 'src/install-commands.ts:948'
  - 'src/install-commands.ts:984'
modified_files:
  - src/install-commands.ts
  - tests/install-commands.test.ts
  - tests/dogfood-installed.test.ts
  - README.md
  - docs/slash-command-adapter-contract.md
  - .claude/commands/pipe.md
  - .claude/commands/inspect.md
  - .opencode/commands/pipe.md
  - .opencode/commands/inspect.md
  - .agents/skills/pipe/SKILL.md
  - .agents/skills/inspect/SKILL.md
  - .kimi/commands/pipe.md
  - .kimi/commands/inspect.md
  - .pi/prompts/pipe.md
  - .pi/prompts/inspect.md
  - .kimi/skills/pipe/SKILL.md
parent_task_id: PIPE-31
priority: medium
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## What

Replace the hardcoded single `pipe` entry in each per-host generator (`claudeDefinitions`, `opencodeDefinitions`, `codexDefinitions`, `kimiDefinitions`, `piDefinitions` in `src/install-commands.ts`) with a `.map` over `Object.entries(config.entrypoints)`. Each entrypoint produces its own slash command at the host-specific path. The body still uses the existing `orchestratorBlock` + `dispatchBlock` builders, but `dispatchBlock` is threaded with the entrypoint id so the generated body invokes `pipe <id> ...` instead of always `pipe ...`.

## Why

Without this, adding `epic` (or any future entrypoint) to `pipeline.yaml` doesn't produce `/epic` slash commands across hosts — users would have to hand-write them. The change is small (the body builders are already data-driven from config) but it's what makes the entrypoint feature feel complete end-to-end.

## Files

`src/install-commands.ts` — touch points:

- `claudeDefinitions(config)` at `:440` → loop over `config.entrypoints` and emit one definition per entrypoint with `.claude/commands/<id>.md`.
- `opencodeDefinitions(config)` at `:502` → same shape for `.opencode/commands/<id>.md`.
- `codexDefinitions(config)` at `:571` → same shape; codex command paths follow the existing `codexDefinitions` convention (verify on read).
- `kimiDefinitions(config)` at `:681` → same shape for `.kimi/commands/<id>.md`.
- `piDefinitions(config)` at `:864` → same shape for `.pi/prompts/<id>.md`.
- `dispatchBlock(host, config)` near `:984` (or wherever the function lives) gains an entrypoint id parameter so it can emit `pipe <id> <description>` instead of `pipe <description>`. Optional shape: `dispatchBlock(host, config, { entrypoint: id })`.
- `invocationForHost(host, id)` near `:984` — generalized for any entrypoint id (currently emits `/pipe ...`).
- `obsoleteGeneratedItems` at `:948` already enumerates generated files via host marker — verify it picks up the new dynamic filenames automatically; if not, extend.

## Body content

The existing `orchestratorBlock(config)` body (the prompt that frames the orchestrator) does not change per-entrypoint — the orchestrator is the same agent regardless of which workflow is being invoked. What differs per slash command is:

- Frontmatter `description` from `entry.description ?? "Run the <id> workflow"`.
- The `dispatchBlock` should reference `pipe <id> <description>` (so the orchestrator dispatches via the new subcommand surface).
- The slash command filename and invocation string.

## Tests (tests/install-commands.test.ts)

1. `install-commands generates one file per configured entrypoint per host`.
2. `Generated body for entrypoint X dispatches via 'pipe X' rather than 'pipe '`.
3. `Removing an entrypoint from config + rerunning install-commands removes the obsolete slash command file (per-host obsolete cleanup)`.
4. `Multiple entrypoints coexist with the per-profile native subagent entries already generated`.
5. `--dry-run` reports the new file set without writing.

## Dependencies

Soft dep on PIPE-31.5 (entrypoint-as-subcommand) so that the generated `pipe <id> ...` invocation in dispatch bodies actually works at runtime. But these can land in either order — the install-commands change is mostly mechanical and doesn't break anything if landed first (the generated `.md` files would simply reference an invocation that fails until the CLI lands).

## Reference

`/Users/oisin/.claude/plans/right-now-we-have-parallel-abelson.md` §"install-commands: one slash command per entrypoint".
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Each per-host generator (`claudeDefinitions`, `opencodeDefinitions`, `codexDefinitions`, `kimiDefinitions`, `piDefinitions`) iterates `Object.entries(config.entrypoints)` instead of hardcoding `pipe`
- [x] #2 Each entrypoint produces a slash command file at the host's expected path with filename `<id>.md`
- [x] #3 `dispatchBlock` threaded with entrypoint id; generated body invokes `pipe <id> <description>` not bare `pipe <description>`
- [x] #4 `invocationForHost` generalized to handle any entrypoint id, replacing the hardcoded `/pipe`
- [x] #5 `obsoleteGeneratedItems` cleanup still removes stale per-host files when an entrypoint is removed from config
- [x] #6 Per-profile native subagent entries (the second block in each generator) are untouched
- [x] #7 Tests added: one file per entrypoint per host, body dispatches via `pipe <id>`, obsolete cleanup after entrypoint removal, multiple entrypoints coexist with native agents, --dry-run output
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Generated one host command surface per configured entrypoint, threaded entrypoint workflow dispatch through generated bodies, generalized invocations, cleaned obsolete per-host command files including the old Kimi skill surface, preserved native per-profile agents, and updated dogfood/docs coverage. Verified with acceptance PASS, verifier PASS, install-commands --check, typecheck, full tests, semgrep, and duplication gate.
<!-- SECTION:FINAL_SUMMARY:END -->
