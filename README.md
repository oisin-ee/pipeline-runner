# oisin-pipeline

Mastra workflow and CLI for running repository work through a fixed pipeline:
collect project knowledge, research the task, write failing tests, implement the
fix, verify the result, and record learnings for future runs.

The reusable primitive is `runPipelinePrimitive()`. It is intended to run from
an isolated worktree for one Backlog.md ticket or task description at a time.
Slash commands call it with a host-native in-process agent adapter; the CLI
calls it with the subprocess adapter.

## Requirements

- Bun 1.1 or newer
- Node.js 22.13 or newer
- Backlog.md CLI available as `backlog`
- One supported agent harness CLI available on `PATH`

Supported harnesses:

| Harness | CLI command used by the runner |
| --- | --- |
| `claude` | `claude --print -p ...` |
| `codex` | `codex exec --json ...` |
| `opencode` | `opencode run --format json ...` |
| `pi` | `pi --mode rpc --no-session` |

Install dependencies:

```shell
bun install --frozen-lockfile
```

The selected harness must already be authenticated and configured in the local
environment. Any provider-specific API keys are managed by that harness.

## Installing In Another Repository

Install the package as a normal dependency, then run the installed binary:

```shell
bun add oisin-pipeline
work-next "Implement PIPE-123 user-facing behavior"
```

The package-level binary is also available:

```shell
oisin-pipeline work-next "Implement PIPE-123 user-facing behavior"
```

Slash-command adapters can import the primitive and adapter types from package
subpaths:

```ts
import { runPipelinePrimitive } from "oisin-pipeline/pipeline-primitive";
import type { AgentAdapter } from "oisin-pipeline/runner";
```

For local unpublished validation, install from a packed tarball instead of
linking:

```shell
bun pm pack
bun add /path/to/oisin-pipeline-1.0.0.tgz
work-next "Implement PIPE-123 user-facing behavior"
```

## Invocation Modes

Use a slash command when you are already inside Claude Code, Codex, OpenCode, or
Pi and want the host interface to execute the phase agents with its native
subagent/session mechanism. The slash command supplies the task text, target
path, in-process agent adapter, and phase reporter to the primitive.

Use the CLI when you are outside an agent host, when automation needs a shell
entrypoint, or when you explicitly want harness CLIs launched as subprocesses.

The slash-command adapter contract for Claude Code, Codex, OpenCode, and Pi is
documented in `docs/slash-command-adapter-contract.md`. This repository also
ships a Claude Code template at `.claude/commands/work-next.md`.

## Running The CLI

Use the package script to start a pipeline run with a task description:

```shell
PIPELINE_HARNESS=codex PIPELINE_TARGET_PATH=/path/to/worktree bun run work-next "Implement PIPE-123 user-facing behavior"
```

`PIPELINE_HARNESS` is optional and defaults to `claude`. If it is set, it must be
one of `claude`, `codex`, `opencode`, or `pi`. Unsupported values are rejected
before Backlog.md tasks or workflow runs are created.

`PIPELINE_TARGET_PATH` is optional and defaults to the current working
directory. Set it when starting the CLI from outside the worktree that should be
modified.

The direct entrypoint is also available:

```shell
bun src/index.ts work-next "Implement PIPE-123 user-facing behavior"
```

The CLI path uses the same primitive as slash commands, but passes the
subprocess adapter from `src/mastra/runner.ts`. Environment variables are only
needed for the CLI adapter; slash commands should supply those values through
their host adapter contract.

## Pipeline Lifecycle

Every run follows the same lifecycle:

1. `knowledge-inject` builds the run context from repository rules and recent
   pipeline knowledge.
2. `research` asks the selected harness to inspect the codebase and summarize
   the task.
3. `RED/test-write` asks the harness to add failing tests and requires the RED
   gate to see tests fail.
4. `GREEN/code-write` asks the harness to implement the change and requires
   tests and typecheck to pass.
5. `VERIFY` runs repository quality checks and an LLM verifier.
6. `LEARN` writes a compact learning artifact for future context injection.

The workflow output has this shape:

```ts
{
  outcome: "PASS" | "FAIL";
  failureDetails: Array<{
    gate: "RED" | "GREEN" | "VERIFY";
    reason: string;
    evidence: string[];
  }>;
}
```

`failureDetails` is empty for a full pass. On failure, it reports the first gate
or gates that prevented the run from passing with captured evidence.

## Backlog.md Phase Mapping

The CLI creates one parent run id and five Backlog.md phase tasks. Their status
tracks the pipeline lifecycle:

| Backlog suffix | Pipeline phase | Meaning |
| --- | --- | --- |
| `R` | `research` | Understand the task and repository context. |
| `TW` | `test-write` / RED | Add failing tests for the requested behavior. |
| `CW` | `implement` / GREEN | Implement code until tests and typecheck pass. |
| `V` | `verify` | Run style, duplication, and LLM verification gates. |
| `L` | `learn` | Persist learnings from the completed run. |

When a gate fails, later phase tasks remain `To Do`, the failing phase remains
`In Progress`, and the failure evidence is appended to that phase task.

## Generated Artifacts

Pipeline artifacts are written under the target worktree:

- `.pipeline/knowledge-context.md`: context assembled from `rules/*.md` and
  recent `.pipeline/knowledge/*.md` files.
- `.pipeline/research.json`: captured research output from the research phase.
- `.pipeline/knowledge/*.md`: learning notes created during the LEARN phase.

The runner also creates Backlog.md phase tasks with ids based on
`TASK-<timestamp>`.

## Verification

Use these exact commands before committing changes in this repository:

```shell
bun run test
bun run typecheck
bun run check
bun run build
```

`bun run test` is the supported test command for this project. It runs the
Vitest suite configured in `package.json`; Bun's native test runner is not the
project suite runner.

## Development

Start Mastra Studio locally:

```shell
bun run dev
```

Open <http://localhost:4111> to inspect and run the Mastra application.

## Known Limitations

- The CLI does not create or switch git worktrees; provide the intended worktree
  with `PIPELINE_TARGET_PATH` or run from that directory.
- The pipeline can modify files in the target worktree through the selected
  harness. Review the diff before committing.
- Harness authentication, model selection, and provider API keys are owned by
  the harness CLI, not this repository.
- The Backlog.md phase ids use `TASK-<timestamp>`, so repeated runs create new
  task groups rather than updating an existing ticket.
- Verification depends on the repository scripts and the verifier output. A
  passing LLM verifier is not a substitute for human review.
