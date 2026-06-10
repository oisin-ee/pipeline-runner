# @oisincoveney/pipeline

Config-driven multi-agent pipeline runner for repository work. Runtime config is
owned by the installed `@oisincoveney/pipeline` package. Repo-local `.pipeline`
paths are runtime artifact locations only; they are not the runtime config
source.

## Requirements

- Bun 1.1 or newer
- Node.js 22.13 or newer
- `npx`, `backlog`, `uvx`, and Docker on `PATH` for default skills and MCP gateway setup
- At least one configured runner CLI on `PATH`: `codex`, `opencode`, `kimi`,
  `pi`, or a declared command runner

Install dependencies:

```shell
bun install --frozen-lockfile
```

## Start A Repository

Initialize package-owned pipeline support:

```shell
pipe init
```

`pipe init` installs default project skills with
`npx skills add oisincoveney/skills`, then writes generated OpenCode and Codex
command surfaces plus their singleton `pipeline-gateway` MCP entries. OpenCode
is the package default runtime; Codex remains a compatibility runner and host
surface. The command does not create repo-local `.pipeline` config files.

The default MCP gateway can run locally or point at the hosted Momokaya
gateway. Set `PIPELINE_MCP_GATEWAY_AUTHORIZATION` to the full HTTP
`Authorization` header value before starting Codex or OpenCode when using a
protected gateway:

```shell
export PIPELINE_MCP_GATEWAY_AUTHORIZATION="Basic $(printf '%s' 'user:password' | base64)"
```

To refresh or check generated host files later, use:

```shell
pipe install-commands --host all --check
```

Check local prerequisites and config health:

```shell
pipe doctor
```

For a compact operator guide covering every command plus how to attach skills
and MCP servers to agent profiles, see `docs/operator-guide.md`.

Validate the config and compiled DAG:

```shell
pipe validate
```

Inspect the execution plan before running:

```shell
pipe explain-plan
```

Generate the default schedule artifact:

```shell
pipe "Implement PIPE-123 user-facing behavior"
```

This writes `.pipeline/runs/<runId>/schedule.yaml` and stops for approval. Run
the approved artifact explicitly:

```shell
pipe run --schedule .pipeline/runs/<runId>/schedule.yaml "Implement PIPE-123 user-facing behavior"
```

Run a read-only repository inspection:

```shell
pipe run --workflow inspect "Report the app structure and available checks. Do not modify files."
```

Run a configured entrypoint alias:

```shell
pipe run --entrypoint dogfood "Run deterministic local verification."
```

Run an epic drain workflow:

```shell
pipe epic PIPE-31
```

The `epic` entrypoint generates a specialized schedule for the epic, writes the
schedule artifact, and stops. Execution uses the same `pipe run --schedule`
approval boundary as `pipe`.

The `pipe` binary also accepts the task directly:

```shell
pipe "Implement PIPE-123 user-facing behavior"
```

Use `PIPELINE_TARGET_PATH=/path/to/worktree` when invoking from outside the
target repository.

## Pipeline Console Runner Image

`oisin-pipeline` is also the runner package/image used by `pipeline-console`.
The control plane owns Argo Workflow submission, run listing, cancellation,
event storage, Kueue discovery, and UI rendering. This package owns the
in-container `runner-command` command used by Argo Workflow DAG tasks: payload
validation, direct argv execution, event translation, authenticated event
posting, signal cancellation, and final event flushing.

Argo starts the image with payload, schedule, and per-task descriptor files
mounted from ConfigMaps, plus the event auth token mounted from a Secret. The
runner reads `--payload-file`, `--schedule-file`, and `/etc/pipeline/task.json`;
the payload contains the workflow id and the task descriptor contains the node
id. The event auth token still comes from the file path specified in
`events.authTokenFile`; payload JSON, task identity, and auth token material are
not delivered through environment variables. The payload contract is documented in
[`docs/pipeline-console-runner-contract.md`](docs/pipeline-console-runner-contract.md).
The executable contract is exported from
`@oisincoveney/pipeline/runner-command-contract` for payload construction,
validation, contract-version checks, and JSON Schema generation.
Use `PIPELINE_TARGET_PATH=/path/to/worktree` when the checked-out target repo is
mounted somewhere other than the process working directory.

## Custom YAML Parts

Runtime execution uses package-owned defaults. Tests and advanced embedding code
can still parse explicit YAML parts with `parsePipelineConfigParts()`.

`runners`:

```yaml
version: 1

runners:
  codex:
    type: codex
    command: codex
    model: gpt-5.5
    capabilities:
      native_subagents: true
      tools: [read, grep, bash, edit, write]
      filesystem: [read-only, workspace-write]
      network: [inherit]
      output_formats: [text, json, jsonl, json_schema]
```

`profiles`:

```yaml
version: 1

profiles:
  orchestrator:
    runner: codex
    instructions:
      inline: Coordinate the workflow from this YAML file only.
    tools: [read, grep, bash]
    filesystem:
      mode: read-only
    network:
      mode: inherit
  implementer:
    runner: codex
    instructions:
      inline: Implement the requested change and return evidence.
    tools: [read, grep, bash, edit, write]
    filesystem:
      mode: workspace-write
    output:
      format: text
```

Example workflow shape:

```yaml
version: 1
default_workflow: default

orchestrator:
  profile: orchestrator

hooks:
  functions: {}
  on: {}

workflows:
  default:
    execution:
      fail_fast: true
      max_parallel_nodes: 2
    nodes:
      - id: implement
        kind: agent
        profile: implementer
        timeout_ms: 300000
        retries:
          max_attempts: 2
          retry_on: [exit_nonzero, gate_failure, timeout]
        gates:
          - kind: builtin
            builtin: test
          - kind: builtin
            builtin: typecheck
```

Package-owned defaults declare `entrypoints` that expose stable app or CLI names
resolving to workflows or schedule policies. Direct `--workflow` selection
remains available and takes precedence over `--entrypoint` when both are set.

The package defaults include a full research, red, green, verify, learn
workflow. See `docs/config-architecture.md` for the host support matrix.

### Structural Parallelism

Workflows and generated schedules can express fixed parallel structure. A
`kind: parallel` node contains a fixed set of child nodes that run concurrently
after dependencies pass. A `kind: group` node groups existing nodes behind a
single dependency target. This is structural parallelism, not dynamic fanout:
agents may route work to tracks, but the branch topology stays auditable in YAML
or in the generated schedule artifact.

The scheduler emits explicit root DAGs for epics:

```yaml
workflows:
  root:
    nodes:
      - id: research
        kind: agent
        profile: pipeline-researcher
      - id: plan
        kind: agent
        profile: pipeline-epic-router
        needs: [research]
      - id: implement
        kind: parallel
        needs: [plan]
        nodes:
          - id: test
            kind: agent
            profile: pipeline-code-writer
          - id: frontend
            kind: agent
            profile: pipeline-code-writer
          - id: backend
            kind: agent
            profile: pipeline-code-writer
          - id: k8s
            kind: agent
            profile: pipeline-code-writer
      - id: verify
        kind: agent
        profile: pipeline-verifier
        needs: [implement]
```

For Argo execution, Git refs carry node state across DAG tasks. Runner tasks
derive state refs from `payload.run.id`, `payload.workflow.id`, and the mounted
task descriptor node id.

Default profile skills and generated host resources are installed by
`pipe init`. Runtime MCP projection and host-specific isolation policy live in
`src/mcp`; see [`docs/mcp-host-isolation.md`](docs/mcp-host-isolation.md) and
[`docs/mcp-gateway.md`](docs/mcp-gateway.md).

## OpenCode-First Goal Loop

Package defaults run built-in profiles through OpenCode first. Pipeline-owned
goal state remains authoritative: continuation prompts, stop reasons, verifier
evidence, acceptance evidence, changed files, and failed gates are stored by the
pipeline, not inferred from an OpenCode session. A goal is complete only when
deterministic verifier evidence and acceptance coverage are both present.

The curated OpenCode stack generated by package config includes:

- project commands, agents, projected skills, explicit permissions, LSP, and the
  singleton `pipeline-gateway` MCP server;
- `.opencode/plugins/pipeline-goal-context.ts`, a package-owned compaction hook
  that injects current goal-loop context into OpenCode continuation summaries;
- `@devtheops/opencode-plugin-otel@1.1.0` in `.opencode/opencode.json`;
- surfaced ecosystem inputs for DCP code, handoff/session capture,
  background-agent delegation, prompt snippets, memory/context helpers, and
  policy hooks.

Team mode is generated as an auditable schedule graph. OpenCode subagents can
execute graph nodes, but dependencies, retries, gates, verifier passes, and
acceptance evidence stay pipeline-owned.

## Generated Host Resources

Generate native host files during setup:

```shell
pipe init
```

Generated resources are derived from package-owned config; they are not separate
sources of truth. Host resources use exact native agents when the node runner
matches the host. OpenCode also uses native subagents for cross-runner
model-backed nodes when the runner/profile provides an OpenCode-compatible
`model` or `host_models.opencode` value. Otherwise generated instructions
dispatch to that runner's CLI instead of inventing a host model.
The installer creates one command surface per configured entrypoint.

| Host        | Generated files                                                   | Invocation                         |
| ----------- | ----------------------------------------------------------------- | ---------------------------------- |
| Codex       | `.agents/skills/<entrypoint>/SKILL.md`, `.agents/plugins/oisin-pipeline/commands/<entrypoint>.md`, `.agents/plugins/oisin-pipeline/agents/*.md`, `.codex/config.toml` | `$pipe <task>`, `$inspect <task>`, `$epic <task>`, `/pipe <task>`, `/inspect <task>`, `/epic <task>` |
| OpenCode    | `.opencode/commands/<entrypoint>.md`, `.opencode/agents/*.md`, `.opencode/skills/*/SKILL.md`, `.opencode/plugins/*.ts`, `.opencode/opencode.json` | `/pipe <task>`, `/inspect <task>`, `/epic <task>` |
| Kimi        | `.kimi/commands/<entrypoint>.md`, `.kimi/agents/*.yaml`           | `/pipe <task>`, `/inspect <task>`, `/epic <task>` |
| Pi          | `.pi/prompts/<entrypoint>.md`                                     | `/pipe <task>`, `/inspect <task>`, `/epic <task>` |

The installer is idempotent, supports `--check` and `--dry-run`, and refuses to
overwrite manually edited files unless `--force` is supplied.

Runner `model` is the canonical model id. Optional `host_models.<host>` entries
are only needed when a host uses a different model identifier:

```yaml
runners:
  kimi:
    type: kimi
    command: kimi
    model: moonshot/kimi-k2.6
```

## Runtime Guarantees

- `pipe run` loads package-owned `@oisincoveney/pipeline` config even when the
  repository has no repo-local `.pipeline` config files.
- Multi-agent workflows execute as separate agent boundaries; nodes are not
  merged into one prompt.
- Native subagent strategy is preferred when the selected runner can represent
  the configured semantics. Otherwise the runtime uses a subprocess boundary.
- Parallel DAG batches run concurrently after dependencies and gates pass.
- `kind: parallel` child sets are fixed in YAML; routing agents decide which
  work belongs in each declared track, not how many tracks exist.
- Workflow execution can cap parallelism and enable fail-fast batch stopping.
- Nodes can declare bounded retries, retry reasons, backoff, and execution
  timeouts.
- Agent self-reporting is not enough to pass deterministic gates.
- JSON Schema gates validate structure only. Use `verdict` and `acceptance`
  gates to enforce semantic pass/fail and per-criterion coverage.
- Command hooks support host policy controls, sanitized environments, timeouts,
  output limits, and JSON file input/result payloads.

## App-Facing API

External apps can import the stable config, planner, schedule, and runtime surfaces
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

## Verification

Use these commands before committing changes in this repository:

```shell
bun run typecheck
bun run check
bun run test
bun run build:cli
```


Argo Workflows can be rendered with `buildRunnerArgoWorkflowManifest` from
`@oisincoveney/pipeline/argo-workflow` and submitted with
`submitRunnerArgoWorkflow` from `@oisincoveney/pipeline/argo-submit`.
