# @oisincoveney/pipeline

Config-driven multi-agent pipeline runner for repository work. The installed
package owns the runtime defaults; target repositories use `.pipeline/runs/` for
generated schedules and run artifacts, not as the source of runtime config.

The published command is `moka`.

## Install

Requirements:

- Node.js 22.13 or newer
- Bun 1.1 or newer for repository development and package build scripts
- `npx`, `backlog`, `uvx`, and Docker on `PATH` for default skills and MCP
  gateway setup
- At least one runner CLI on `PATH`: `opencode` or a configured command runner

Install the package in a target repository:

```shell
npm install --save-dev @oisincoveney/pipeline
```

Then run the local package binary:

```shell
moka --help
```

For development inside this repository:

```shell
bun install --frozen-lockfile
bun run build:cli
```

## Start A Repository

Initialize package-owned pipeline support:

```shell
moka init
```

`moka init` vendors the package's default project skills, then writes generated
OpenCode command surfaces plus the singleton `pipeline-gateway` MCP entry.
OpenCode is the package default runtime. The command does not create repo-local
`.pipeline` config files.

The default MCP gateway can run locally or point at the hosted Momokaya gateway.
Set `PIPELINE_MCP_GATEWAY_AUTHORIZATION` to the full HTTP `Authorization` header
value before starting OpenCode when using a protected gateway:

```shell
export PIPELINE_MCP_GATEWAY_AUTHORIZATION="Basic $(printf '%s' 'user:password' | base64)"
```

Check or refresh generated host files after package upgrades:

```shell
moka install-commands --host all --check
```

Check local prerequisites and config health:

```shell
moka doctor
```

Validate the package-owned config and compiled workflow plan:

```shell
moka validate
```

Inspect the execution plan:

```shell
moka explain-plan
```

## Command Surface

`moka submit "<task>"`

Generates the full graph schedule for a task, builds the runner payload from the
current git context, and submits an Argo Workflow to the configured Momokaya
cluster.

```shell
moka submit "Implement PIPE-123 user-facing behavior"
```

`moka submit "<task>" --quick`

Uses the compact graph for smaller work.

```shell
moka submit "Fix the login bug" --quick
```

`moka submit --schedule <schedule.yaml> "<task>"`

Submits a previously approved schedule artifact.

```shell
moka submit --schedule .pipeline/runs/<runId>/schedule.yaml "Implement PIPE-123"
```

`moka submit --command -- <argv...>`

Submits one explicit command as a one-task Argo Workflow.

```shell
moka submit --command -- opencode run "fix this bug"
```

`moka run "<task>"`

Runs package-owned workflow config from the current worktree. Scheduled
entrypoints generate a schedule artifact under `.pipeline/runs/<runId>/` and run
the compiled schedule through the runtime.

```shell
moka run "Implement PIPE-123 user-facing behavior"
moka run --schedule .pipeline/runs/<runId>/schedule.yaml "Implement PIPE-123"
moka run --workflow inspect "Report the app structure and available checks. Do not modify files."
moka run --entrypoint quick "Implement a focused fix"
```

`moka inspect "<task>"`

Runs the configured read-only inspection entrypoint.

```shell
moka inspect "Explain the app structure and available checks"
```

Use `PIPELINE_TARGET_PATH=/path/to/worktree` when invoking `moka` from outside
the target repository.

For a compact command reference, see
[`docs/operator-guide.md`](docs/operator-guide.md).

## Momokaya Runner Image

The package is also the runner code used by the Momokaya runner image. The
control plane owns Argo Workflow submission, run listing, cancellation, event
storage, Kueue discovery, and UI rendering. This package owns the in-container
`moka runner-command` and `moka runner-finalize` commands used by Argo Workflow
DAG tasks.

Argo starts the image with payload, schedule, and per-task descriptor files
mounted from ConfigMaps, plus the event auth token mounted from a Secret. The
runner reads `--payload-file`, `--schedule-file`, and `/etc/pipeline/task.json`;
payload JSON, task identity, and auth token material are not delivered through
environment variables. The payload contract is documented in
[`docs/pipeline-console-runner-contract.md`](docs/pipeline-console-runner-contract.md).

Submitters can import the executable contract from
`@oisincoveney/pipeline/runner-command-contract` for payload construction,
validation, contract-version checks, and JSON Schema generation.

Pipeline Console submits hosted runs through `@oisincoveney/pipeline/moka-submit`.
The subpath exports `mokaSubmitOptionsSchema`, `mokaSubmitResultSchema`,
`MokaSubmitOptionsInput`, `MokaSubmitOptionsOutput`, `MokaSubmitInput`,
`MokaSubmitOutput`, and `submitMoka` so callers can validate prompt or ticket
tasks with explicit repository, run, delivery, event sink, and runner settings
without importing Argo, Kubernetes, or runner-command internals.

## Configuration Model

Runtime execution uses package-owned defaults. Tests and advanced embedding code
can still parse explicit YAML parts with `parsePipelineConfigParts()`.

Package-owned defaults declare:

- runner adapters and capabilities
- profiles, rules, skills, tools, filesystem grants, network grants, and output
  contracts
- the singleton `pipeline-gateway` MCP connection
- workflows, schedules, hooks, gates, artifacts, retries, and timeouts
- generated OpenCode host resources
- goal-loop contracts and continuation context

Current default entrypoints:

```yaml
entrypoints:
  quick:
    schedule: quick-schedule
  execute:
    schedule: execute-schedule
  inspect:
    workflow: inspect
```

Current schedule policies:

```yaml
scheduler:
  commands:
    quick:
      schedule: quick-schedule
      catalog: quick
    execute:
      schedule: execute-schedule
      catalog: execute
```

Workflows and generated schedules can express fixed parallel structure. A
`kind: parallel` node contains a fixed set of child nodes that run concurrently
after dependencies pass. A `kind: group` node groups existing nodes behind a
single dependency target. Agents may route work to tracks, but the branch
topology stays auditable in YAML or in the generated schedule artifact.

See [`docs/config-architecture.md`](docs/config-architecture.md) for the config
shape and [`docs/xstate-runtime-actor-model.md`](docs/xstate-runtime-actor-model.md)
for the runtime actor model.

## Generated Host Resources

Generate native host files during setup:

```shell
moka init
```

Generated resources are derived from package-owned config; they are not separate
sources of truth. Host resources use OpenCode native agents for model-backed
nodes. Otherwise generated instructions dispatch to the configured command
runner.

| Host | Generated files | Invocation |
| --- | --- | --- |
| OpenCode | `.opencode/commands/<entrypoint>.md`, `.opencode/agents/*.md`, `.opencode/skills/*/SKILL.md`, `.opencode/plugins/*.ts`, `.opencode/opencode.json` | `/quick <task>`, `/execute <task>`, `/inspect <task>` |

The installer is idempotent, supports `--check` and `--dry-run`, and refuses to
overwrite manually edited files unless `--force` is supplied.

## OpenCode-First Goal Loop

Package defaults run built-in profiles through OpenCode first. Pipeline-owned
goal state remains authoritative: continuation prompts, stop reasons, verifier
evidence, acceptance evidence, changed files, and failed gates are stored by the
pipeline, not inferred from an OpenCode session. A goal is complete only when
deterministic verifier evidence and acceptance coverage are both present.

Team mode is generated as an auditable schedule graph. OpenCode subagents can
execute graph nodes, but dependencies, retries, gates, verifier passes, and
acceptance evidence stay pipeline-owned.

## Runtime Guarantees

- `moka run` loads package-owned `@oisincoveney/pipeline` config even when the
  repository has no repo-local `.pipeline` config files.
- Multi-agent workflows execute as separate agent boundaries; nodes are not
  merged into one prompt.
- Native subagent strategy is preferred when the selected runner can represent
  the configured semantics. Otherwise the runtime uses a subprocess boundary.
- Parallel DAG batches run concurrently after dependencies and gates pass.
- Workflow execution can cap parallelism and enable fail-fast batch stopping.
- Nodes can declare bounded retries, retry reasons, backoff, and execution
  timeouts.
- Agent self-reporting is not enough to pass deterministic gates.
- JSON Schema gates validate structure only. Use `verdict` and `acceptance`
  gates to enforce semantic pass/fail and per-criterion coverage.
- Command hooks support host policy controls, sanitized environments, timeouts,
  output limits, and JSON file input/result payloads.

## App-Facing API

External apps can import stable config, planner, schedule, and runtime surfaces
without deep-importing private source paths:

```ts
import {
  loadPipelineConfig,
  parsePipelineConfigParts,
} from "@oisincoveney/pipeline/config";
import { compileWorkflowPlan } from "@oisincoveney/pipeline/planner";
import {
  compileScheduleArtifact,
  parseScheduleArtifact,
} from "@oisincoveney/pipeline/schedule";
import {
  runPipelineFromConfig,
  type PipelineRuntimeResult,
  type PipelineTaskContext,
} from "@oisincoveney/pipeline/runtime";
```

Hook modules can import the typed helper and result contract:

```ts
import {
  defineHook,
  type HookContext,
  type HookResult,
} from "@oisincoveney/pipeline/hooks";
```

Runner Job producers can import the shared payload contract:

```ts
import {
  buildRunnerCommandPayload,
  parseRunnerCommandPayload,
  runnerCommandPayloadSchema,
} from "@oisincoveney/pipeline/runner-command-contract";
```

Argo Workflows can be rendered with `buildRunnerArgoWorkflowManifest` from
`@oisincoveney/pipeline/argo-workflow` and submitted with
`submitRunnerArgoWorkflow` from `@oisincoveney/pipeline/argo-submit`.

## Release And Verification

Package and container publishing is owned by GitHub Actions. Do not publish from
a workstation with `npm publish`, `semantic-release`, Docker pushes, or direct
registry commands.

Before committing changes in this repository, run:

```shell
bun run typecheck
bun run check
bun run test
bun run build:cli
```

For runner-image wiring, also run:

```shell
bun run test:image
```
