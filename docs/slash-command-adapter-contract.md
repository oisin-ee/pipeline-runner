# Slash Command Adapter Contract

The reusable primitive is `runPipelinePrimitive(input, adapters)` from
`src/mastra/pipeline-primitive.ts`. The shell CLI calls that primitive with the
subprocess adapter from `src/mastra/runner.ts`.

Generated host resources do not shell out to `work-next`. They encode the same
pipeline lifecycle for the host interface and use the host's native command,
skill, agent, subagent, extension, or session mechanics.

Install the generated resources in a repository with:

```sh
bunx @oisincoveney/pipeline install-commands --host all
```

The installer is idempotent, supports `--dry-run`, supports `--check`, and
refuses to overwrite manually edited files unless `--force` is passed.

## Host Mappings

| Host | Generated resources | Invocation | Mechanical path |
| --- | --- | --- | --- |
| Claude Code | `.claude/commands/work-next.md`, `.claude/agents/pipeline-*.md` | `/work-next <task>` | Project command orchestrates named Claude Code project agents. |
| OpenCode | `.opencode/commands/work-next.md`, `.opencode/agents/pipeline-*.md` | `/work-next <task>` | Project command runs `pipeline-orchestrator`, which delegates to OpenCode subagents. |
| Pi | `.pi/extensions/work-next.ts`, `.pi/prompts/work-next.md` | `/work-next <task>` | Project extension registers the command and requires `pi-subagents` before sending the phase prompt. |
| Codex | `.agents/skills/work-next/SKILL.md`, `.codex/agents/pipeline-*.toml` | `$work-next <task>` or `/skills` | Project skill instructs Codex to spawn the generated Codex agents for phase work. |

Codex currently does not expose project-defined custom slash commands in the
same way as Claude Code and OpenCode. The installer therefore generates a Codex
skill and Codex agent definitions rather than pretending that `/work-next`
exists in Codex.

## Pipeline Contract

Every generated host resource uses the shared pipeline spec from
`src/pipeline-spec.ts`:

1. Build `.pipeline/knowledge-context.md`.
2. Run research with `pipeline-researcher`.
3. Run RED with `pipeline-test-writer`; the new tests must fail for the right
   reason.
4. Run GREEN with `pipeline-code-writer`; tests and typecheck must pass.
5. Run VERIFY with `pipeline-verifier`; quality checks and implementation
   review must pass.
6. Write `.pipeline/knowledge/<timestamp>.md`.

The host resource is responsible for keeping the command or skill invocation as
the orchestrator, delegating phase work to the configured agents, and stopping
with evidence when a gate fails.

## CLI Adapter

The CLI remains the shell automation path. It supplies:

- `task`: the command argument.
- `worktreePath`: `PIPELINE_TARGET_PATH` or the current directory.
- `harness`: `PIPELINE_HARNESS` or `claude`.
- `agentAdapter`: the subprocess adapter that calls the configured harness CLI.

The CLI is the only path that intentionally starts `claude`, `codex`,
`opencode`, or `pi` as subprocesses.
