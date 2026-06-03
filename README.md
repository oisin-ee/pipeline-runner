# @oisincoveney/pipeline

Config-driven multi-agent pipeline runner for repository work. The source of
truth is three YAML files: `.pipeline/runners.yaml` declares runner adapters,
`.pipeline/profiles.yaml` declares reusable profiles and their grants, and
`.pipeline/pipeline.yaml` declares orchestration, workflows, gates, hooks, and
artifacts.

## Requirements

- Bun 1.1 or newer
- Node.js 22.13 or newer
- `npx`, `backlog`, `uvx`, and Docker on `PATH` for default skills and MCP setup
- At least one configured runner CLI on `PATH`: `codex`, `claude`,
  `opencode`, `kimi`, `pi`, or a declared command runner

Install dependencies:

```shell
bun install --frozen-lockfile
```

## Start A Repository

Scaffold the default YAML workflow:

```shell
pipe init
```

`pipe init` installs default project skills with
`npx skills add oisincoveney/skills` and registers default MCP servers with the
MCPM CLI from https://mcpm.sh/. Default profiles point at the installed
`.agents/skills/<skill>/SKILL.md` files in the target repository. The package
invokes MCPM through `uvx --python 3.12 mcpm`, so generated `.mcp.json` entries
do not depend on a globally installed `mcpm` binary. The default Qdrant/memory
MCP is the Momokaya remote endpoint
`https://memory-mcp.momokaya.ee/mcp/`.

The default GitHub MCP registration uses GitHub's official container in
read-only mode and reads `GITHUB_PERSONAL_ACCESS_TOKEN` from the environment.
The Momokaya Qdrant endpoint is protected by Traefik HTTP Basic auth. Set
`MEMORY_MCP_BASIC_AUTH` to the base64 `user:password` payload before running
`pipe init` if you want init to register that remote server with MCPM:

```shell
export MEMORY_MCP_BASIC_AUTH="$(printf '%s' 'user:password' | base64)"
```

When `MEMORY_MCP_BASIC_AUTH` is not set, `pipe init` still writes the default
scaffold and keeps the generated `qdrant` MCP entry, but skips immediate MCPM
registration for that private endpoint.

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
The console owns Kubernetes Job creation, run listing, cancellation, event
storage, Kueue discovery, and UI rendering. This package owns the in-container
`runner-job` command: payload validation, existing runtime invocation, event
translation, authenticated event posting, signal cancellation, and final event
flushing.

The console starts the image with `OISIN_PIPELINE_RUNNER_PAYLOAD_JSON` and the
runner-side event token. The payload contract is documented in
[`docs/pipeline-console-runner-contract.md`](docs/pipeline-console-runner-contract.md).
Use `PIPELINE_TARGET_PATH=/path/to/worktree` when the checked-out target repo is
mounted somewhere other than the process working directory.

## Minimal YAML

`.pipeline/runners.yaml`:

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

`.pipeline/profiles.yaml`:

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

`.pipeline/pipeline.yaml`:

```yaml
version: 1
default_workflow: default

orchestrator:
  profile: orchestrator
  hooks: []

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

Projects can also declare `entrypoints` in `.pipeline/pipeline.yaml` to expose
stable app or CLI names that resolve to workflows or schedule policies. Direct
`--workflow` selection remains available and takes precedence over `--entrypoint`
when both are set.

The default scaffold includes a full research, red, green, verify, learn
workflow. See `docs/config-architecture.md` for a complete example and the host
support matrix.

### Structural Parallelism

Workflows can compose other workflows with fixed YAML structure. A
`kind: workflow` node invokes another named workflow; without `worktree_root` it
runs in the current worktree, and with `worktree_root` it runs in an isolated
git worktree. A `kind: parallel` node contains a fixed set of child nodes that
run concurrently after dependencies pass. This is structural parallelism, not
dynamic fanout: agents may route work to tracks, but the branch topology stays
auditable in YAML.

The built-in `epic` entrypoint uses those primitives:

```yaml
entrypoints:
  epic:
    workflow: epic-drain
    description: Route an epic's tickets into specialist tracks, run them in parallel, then thermo-nuclear review.

workflows:
  epic-drain:
    description: Research, route, parallel-implement tracks in isolated worktrees, integrate, thermo-nuclear review.
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
            kind: workflow
            workflow: default
            worktree_root: .pipeline/runs/${runId}/test
          - id: frontend
            kind: workflow
            workflow: default
            worktree_root: .pipeline/runs/${runId}/frontend
          - id: backend
            kind: workflow
            workflow: default
            worktree_root: .pipeline/runs/${runId}/backend
          - id: k8s
            kind: workflow
            workflow: infra
            worktree_root: .pipeline/runs/${runId}/k8s
      - id: merge
        kind: builtin
        builtin: drain-merge
        needs: [implement]
      - id: review
        kind: agent
        profile: pipeline-thermo-nuclear-reviewer
        needs: [merge]
        gates:
          - { id: review-verdict, kind: verdict, target: stdout }
```

Use `.pipeline/runs/${runId}/<track>` for isolated track worktrees; the default
`.gitignore` excludes `.pipeline/runs/`. The `drain-merge` builtin consumes the
parallel output, skips non-passing or non-worktree children, verifies mergeable
branches share a base SHA, and merges passing branches into an integration
branch in declaration order. It reports merge conflicts; it does not resolve
them automatically.

Default profile skills are installed into `.agents/skills` by `pipe init`.
Runtime MCP projection and host-specific isolation policy live in `src/mcp`; see
[`docs/mcp-host-isolation.md`](docs/mcp-host-isolation.md) and
[`docs/mcp-gateway.md`](docs/mcp-gateway.md).

## Generated Host Resources

Generate native host files from the YAML config:

```shell
pipe install-commands --host all
```

Generated resources are derived from the three config files; they are not
separate sources of truth. Host resources use exact native agents when the node
runner matches the host. OpenCode also uses native subagents for cross-runner
model-backed nodes when the runner/profile provides an OpenCode-compatible
`model` or `host_models.opencode` value. Otherwise generated instructions
dispatch to that runner's CLI instead of inventing a host model.
The installer creates one command surface per configured entrypoint.

| Host        | Generated files                                                   | Invocation                         |
| ----------- | ----------------------------------------------------------------- | ---------------------------------- |
| Claude Code | `.claude/commands/<entrypoint>.md`, `.claude/agents/*.md`         | `/pipe <task>`, `/inspect <task>`, `/epic <task>` |
| Codex       | `.agents/skills/<entrypoint>/SKILL.md`, `.agents/plugins/oisin-pipeline/commands/<entrypoint>.md`, `.agents/plugins/oisin-pipeline/agents/*.md`, `.codex/config.toml` | `$pipe <task>`, `$inspect <task>`, `$epic <task>`, `/pipe <task>`, `/inspect <task>`, `/epic <task>` |
| OpenCode    | `.opencode/commands/<entrypoint>.md`, `.opencode/agents/*.md`     | `/pipe <task>`, `/inspect <task>`, `/epic <task>` |
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

- `pipe run` fails without `.pipeline/pipeline.yaml`,
  `.pipeline/profiles.yaml`, and `.pipeline/runners.yaml`.
- Multi-agent workflows execute as separate agent boundaries; nodes are not
  merged into one prompt.
- Native subagent strategy is preferred when the selected runner can represent
  the configured semantics. Otherwise the runtime uses a subprocess boundary.
- Parallel DAG batches run concurrently after dependencies and gates pass.
- `kind: parallel` child sets are fixed in YAML; routing agents decide which
  work belongs in each declared track, not how many tracks exist.
- `kind: workflow` nodes invoke named workflows and can run in isolated
  worktrees when `worktree_root` is set.
- Worktree roots support `${runId}` and `${nodeId}` templates and should live
  under `.pipeline/runs/` for generated run artifacts.
- `drain-merge` merges passing worktree branches in declaration order and
  reports conflicts for manual resolution.
- Workflow execution can cap parallelism and enable fail-fast batch stopping.
- Nodes can declare bounded retries, retry reasons, backoff, and execution
  timeouts.
- Agent self-reporting is not enough to pass deterministic gates.
- JSON Schema gates validate structure only. Use `verdict` and `acceptance`
  gates to enforce semantic pass/fail and per-criterion coverage.
- Command hooks support host policy controls, sanitized environments, timeouts,
  output limits, and JSON payloads on stdin.

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

## Verification

Use these commands before committing changes in this repository:

```shell
bun run typecheck
bun run check
bun run test
bun run build:cli
```
