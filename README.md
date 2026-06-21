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

`moka init` installs or refreshes the whole per-machine harness in one step:
the package's default skills, generated host command surfaces, the singleton
`pipeline-gateway` MCP entry, copied hook files from the private
`oisin-ee/agent-hooks` repository, and global instruction files. OpenCode is the
package default runtime. The command does not create repo-local `.pipeline`
config files.

The default MCP gateway can run locally or point at the hosted Momokaya gateway.
Set `PIPELINE_MCP_GATEWAY_AUTHORIZATION` to the full HTTP `Authorization` header
value before starting OpenCode when using a protected gateway:

```shell
export PIPELINE_MCP_GATEWAY_AUTHORIZATION="Basic $(printf '%s' 'user:password' | base64)"
```

Verify the generated harness (commands, hooks, rules) is current after package
upgrades or edits to `oisin-ee/agent-hooks`, without writing anything:

```shell
moka init --check
```

Refresh it, overwriting any locally edited harness files:

```shell
moka init --force
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

`moka run "<task>"` is the primary command surface.

It runs package-owned workflow config from the current worktree. Scheduled
entrypoints generate a schedule artifact under `.pipeline/runs/<runId>/` and run
the compiled schedule through the runtime.

Canonical commands:

- `moka run "<task>"`: start the primary local or remote run flow.
- `moka runs`: list known runs, newest first.
- `moka status <run-id>`: show run and node status; add `--watch` to poll.
- `moka logs <run-id> [node-id]`: print whole-run or node-specific artifacts.
- `moka stop <run-id> [node-id]`: abort a run or one active node.
- `moka export <run-id> --sanitize`: print a portable evidence bundle.
- `moka doctor`: check local prerequisites and config health.
- `moka init`: install or refresh the whole per-machine harness (skills,
  command surfaces, hooks, rules). `--check` verifies without writing,
  `--dry-run` previews, `--force` overwrites locally edited files. The harness
  is always installed globally; there is no `--scope`.

```shell
moka run "Implement PIPE-123 user-facing behavior"
moka run --target local --effort normal "Implement a standard local change"
moka run --schedule .pipeline/runs/<runId>/schedule.yaml "Implement PIPE-123"
moka run --workflow inspect "Report the app structure and available checks. Do not modify files."
moka run --effort quick "Implement a focused fix"
moka run --effort normal "Implement a standard fix"
moka run --target remote --effort thorough "Submit a full hosted graph run"
moka run --read-only "Inspect the repository without edits"
moka run --target remote --command -- opencode run "fix this bug"
moka init --force
```

Flag defaults and choices:

- `--target` selects `local` (default, current worktree) or `remote` (hosted
  Momokaya submission). Use canonical `moka run --target remote "<task>"` for
  hosted graph runs.
- `--effort` selects `quick`, `normal`, or `thorough`; `normal` is the default.
- `--read-only` switches mode to `read`; mode defaults to `write`.

Moka ticket selects and scopes Backlog work; moka run executes selected work.
Use Backlog CLI for task creation and editing instead of direct markdown edits.

```shell
moka ticket graph check --root PIPE-84
moka ticket sequence --root PIPE-84 --plain
moka ticket next --root PIPE-84 --json
moka ticket next --claim --root PIPE-84
moka ticket create --dry-run "Plan a small Backlog task"
moka ticket create --apply --parent PIPE-84 "Plan and create child tasks"
moka ticket start --root PIPE-84
moka ticket start --dry-run --root PIPE-84 --effort quick --target local
```

Read-only ticket commands are `moka ticket graph check`, `moka ticket sequence`,
`moka ticket next`, `moka ticket create --dry-run`, and
`moka ticket start --dry-run`. Commands that mutate or run work are
`moka ticket next --claim`, `moka ticket create --apply`, and
`moka ticket start` without `--dry-run`: they use Backlog CLI task creation and
editing or invoke `moka run` for the selected ticket.

Local run artifacts live under `.pipeline/runs/<runId>/`:

```text
.pipeline/runs/<runId>/
  schedule.yaml
  manifest.json
  status.json
  events.ndjson
  nodes/<node-id>/
  artifacts/
```

Use `moka export <run-id> --sanitize` before sharing a run. The sanitized export
keeps portable evidence and omits prompt text, session body content, secrets,
tokens, and credentials.

Compatibility aliases and presets remain available for existing scripts:

- `moka quick "<task>"` is a compatibility preset for
  `moka run --effort quick "<task>"`.
- `moka execute "<task>"` is a compatibility preset for
  `moka run --effort thorough "<task>"`.
- `moka inspect "<task>"` is a compatibility preset for
  `moka run --read-only "<task>"`.
- `moka submit "<task>"` is a compatibility alias for
  `moka run --target remote --effort thorough "<task>"`. Its existing `--quick`,
  `--schedule`, and `--command` options remain supported for remote submissions.

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
`mokaSubmitDirectHooksSchema`, `mokaSubmitHookPolicySchema`,
`MokaSubmitOptionsInput`, `MokaSubmitOptionsOutput`,
`MokaSubmitDirectHooksInput`, `MokaSubmitHookPolicyInput`, `MokaSubmitInput`,
`MokaSubmitOutput`, and `submitMoka` so callers can validate prompt or ticket
tasks with explicit repository, run, delivery, event sink, lifecycle hooks, hook
policy, and runner settings without importing Argo, Kubernetes, or
runner-command internals. `eventSink` is runner event transport; direct `hooks`
configure runner-side lifecycle behavior and are normalized into internal
runtime hook config by the package. Direct hook function ids are generated as
`moka-submit-<event-name-with-dashes>`; existing package hooks are preserved,
and a generated id that already exists in the supplied config is rejected.

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
- internal goal-state artifacts and goal-loop continuation context

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
shape and [`docs/runtime-actor-model.md`](docs/runtime-actor-model.md)
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
| OpenCode | `.opencode/commands/moka-<entrypoint>.md`, `.opencode/agents/*.md`, `.opencode/plugins/*.ts`, `.opencode/opencode.json` | `/moka-quick <task>`, `/moka-execute <task>`, `/moka-inspect <task>` |

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
