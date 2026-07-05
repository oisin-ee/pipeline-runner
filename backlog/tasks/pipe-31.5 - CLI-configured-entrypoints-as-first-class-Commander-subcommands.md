---
id: PIPE-31.5
title: "CLI: configured entrypoints as first-class Commander subcommands"
status: Done
assignee: []
created_date: "2026-05-28 17:44"
updated_date: "2026-05-28 20:25"
labels:
  - drain
  - cli
milestone: m-0
dependencies: []
references:
  - /Users/oisin/.codex/plans/right-now-we-have-parallel-abelson.md
  - "src/index.ts:284"
  - "src/index.ts:404"
modified_files:
  - src/config.ts
  - src/index.ts
  - tests/cli.test.ts
parent_task_id: PIPE-31
priority: high
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

## What

Make every entry in `config.entrypoints` automatically a Commander subcommand discoverable in `pipe --help`. `pipe epic ...`, `pipe drain ...`, and any future entrypoint just work — no per-entrypoint code edits required.

## Why

Today entrypoints live in `pipeline.yaml` but the CLI bin only knows about a hardcoded set of administrative subcommands (`run`, `validate`, `doctor`, `init`, `install-commands`, `explain-plan`) plus a fallback that treats unrecognized args as a description for the default workflow. Users who add an `epic` entrypoint can only invoke it via `pipe run --entrypoint epic ...`. That's invisible to `--help` and clunky. The fix is one CLI change that makes config-defined entrypoints first-class.

## Semantics

- `createCliProgram()` (in `src/index.ts`) loads `pipeline.yaml` eagerly when the program is built and registers a `.command(<entrypointId>)` for each `config.entrypoints` entry. Each subcommand:
  - Description: `entry.description ?? "Run the <id> workflow"`.
  - Argument: `<description...>` (same as `run`).
  - Action: `pipe(descriptionParts.join(" "), { entrypoint: id })`.
- `pipe run --entrypoint <name> ...` keeps working unchanged. The new subcommands are sugar.
- The pre-existing fallback (`pipe foo bar baz` → `pipe run foo bar baz`) stays for anything Commander doesn't recognize.

## Collision policy (npm-style)

Builtin subcommands always win at the top level. If you name an entrypoint `validate`, `doctor`, `init`, `install-commands`, `run`, or `explain-plan`:

- `pipe validate` runs the builtin (no override).
- The colliding entrypoint is still reachable via `pipe run --entrypoint validate ...` — the always-available escape hatch.
- `pipe validate` (the lint command — see PIPE-31.6) emits a **warning**, not an error: `entrypoint 'validate' is shadowed by the builtin subcommand; invoke via 'pipe run --entrypoint validate ...'`.

Implementation: build a `DIRECT_SUBCOMMANDS` set; skip registration when an entrypoint id is in it. Lint surfaces the collision separately.

## Config-error propagation (no silent fall-through)

`createCliProgram` and `runCli` do NOT swallow config-load failures. If `pipeline.yaml` is missing, malformed, or fails schema validation, the CLI prints the error and exits non-zero — including for `pipe epic foo` where the user might think "epic" is just a description. Silent misinterpretation is worse than a clear error.

Exception: `pipe init` and `pipe doctor` work without a config (init creates one; doctor checks prerequisites). These must remain in an always-direct subcommand path that bypasses config-loading entirely. Two reasonable implementations: (a) short-circuit before building the Commander program when `argv[2]` is `init` or `doctor`; (b) inside `createCliProgram`, do a soft `tryLoadPipelineConfig` that returns `null` when the file is _missing_, but propagates _malformed_ errors. Either is acceptable; pick the one with smaller diff.

## Implementation sketch (the new bit, ~30 lines)

```ts
export function createCliProgram(): Command {
  const program = new Command()
    .name("@oisincoveney/pipeline")
    .description("Run and install the oisin pipeline")
    .exitOverride();

  // existing run / pipe / validate / explain-plan / doctor / init / install-commands ...

  const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
  const config = tryLoadPipelineConfig(cwd); // returns null when MISSING; throws on malformed
  if (config) {
    for (const [id, entry] of Object.entries(config.entrypoints)) {
      if (DIRECT_SUBCOMMANDS.has(id)) continue;
      program
        .command(id)
        .description(entry.description ?? `Run the ${id} workflow`)
        .argument("<description...>", "task description")
        .action((descriptionParts: string[]) =>
          pipe(descriptionParts.join(" "), { entrypoint: id })
        );
    }
  }
  return program;
}
```

`runCli` simplifies: the new subcommands are real, so Commander finds them naturally; the existing `pipe <anything>` → `pipe run <anything>` rewrite remains as fallback for everything Commander doesn't recognize.

## Tests (tests/cli.test.ts)

1. `pipe <entrypoint-id> "<description>"` dispatches to that entrypoint with the description.
2. `pipe --help` lists configured entrypoints with their descriptions.
3. `pipe validate` runs the builtin even when an entrypoint named `validate` exists in config.
4. Configured entrypoint named `validate` is reachable via `pipe run --entrypoint validate ...`.
5. Missing `pipeline.yaml`: `pipe init` and `pipe doctor` still work; other entrypoint dispatches return a clear error (or fall through cleanly per the chosen impl).
6. Malformed `pipeline.yaml`: any non-bootstrap CLI invocation exits non-zero with the schema error.

## Dependencies

None inside this epic. Sequencing: `pipe validate` lint extensions (PIPE-31.6) follow this one, since they target the new subcommand surface.

## Reference

`/Users/oisin/.codex/plans/right-now-we-have-parallel-abelson.md` §"CLI: entrypoints as first-class subcommands".

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 `createCliProgram()` loads `pipeline.yaml` eagerly via `tryLoadPipelineConfig` and registers a `.command(<id>)` per entry in `config.entrypoints`
- [x] #2 Each registered subcommand description defaults to `entrypoint.description` and dispatches to `pipe(desc, { entrypoint: id })`
- [x] #3 `pipe run --entrypoint <name>` continues to work unchanged — the new surface is additive sugar
- [x] #4 Builtin subcommands (`run`, `validate`, `doctor`, `init`, `install-commands`, `explain-plan`) win on name collision; colliding entrypoints are still reachable via `pipe run --entrypoint <name>`
- [x] #5 `pipe init` and `pipe doctor` work in repos with no `pipeline.yaml`
- [x] #6 Malformed `pipeline.yaml` causes non-bootstrap CLI invocations to exit non-zero with the validation error — no silent fall-through to the default-run rewrite
- [x] #7 Tests added: subcommand dispatch, --help lists entrypoints, collision wins for builtin, escape hatch via --entrypoint, init/doctor work without config, malformed config errors propagate
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Implemented configured entrypoints as first-class Commander subcommands through the configured pipe workflow. `createCliProgram()` now eagerly soft-loads pipeline config, registers non-colliding entrypoints with descriptions and `<description...>` arguments, preserves builtin command precedence plus the `pipe` alias, and `runCli()` recognizes dynamic commands before falling back to default run rewriting. Added CLI coverage for dynamic dispatch/help, builtin collision, `run --entrypoint` escape hatch, bootstrap init/doctor without config, and malformed config propagation. Verification passed: acceptance PASS, verifier PASS, typecheck, full tests, semgrep, and duplication.

<!-- SECTION:FINAL_SUMMARY:END -->
