# @oisincoveney/pipeline

Config-driven multi-agent pipeline runner for repository work. The source of
truth is three YAML files: `.pipeline/runners.yaml` declares runner adapters,
`.pipeline/profiles.yaml` declares reusable profiles and their grants, and
`.pipeline/pipeline.yaml` declares orchestration, workflows, gates, hooks, and
artifacts.

## Requirements

- Bun 1.1 or newer
- Node.js 22.13 or newer
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

Validate the config and compiled DAG:

```shell
pipe validate
```

Inspect the execution plan before running:

```shell
pipe explain-plan
```

Run the default workflow:

```shell
pipe run "Implement PIPE-123 user-facing behavior"
```

Run a read-only repository inspection:

```shell
pipe run --workflow inspect "Report the app structure and available checks. Do not modify files."
```

Run a configured entrypoint alias:

```shell
pipe run --entrypoint dogfood "Run deterministic local verification."
```

The `pipe` binary also accepts the task directly:

```shell
pipe "Implement PIPE-123 user-facing behavior"
```

Use `PIPELINE_TARGET_PATH=/path/to/worktree` when invoking from outside the
target repository.

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
stable app or CLI names that resolve to workflows. Direct `--workflow` selection
remains available and takes precedence over `--entrypoint` when both are set.

The default scaffold includes a full research, red, green, verify, learn
workflow. See `docs/config-architecture.md` for a complete example and the host
support matrix.

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

| Host        | Generated files                                        | Invocation           |
| ----------- | ------------------------------------------------------ | -------------------- |
| Claude Code | `.claude/commands/pipe.md`, `.claude/agents/*.md`      | `/pipe <task>`       |
| Codex       | `.agents/skills/pipe/SKILL.md`, `.codex/agents/*.toml` | `$pipe <task>`       |
| OpenCode    | `.opencode/commands/pipe.md`, `.opencode/agents/*.md`  | `/pipe <task>`       |
| Kimi        | `.kimi/skills/pipe/SKILL.md`, `.kimi/agents/*.yaml`    | `/skill:pipe <task>` |
| Pi          | `.pi/prompts/pipe.md`                                  | `/pipe <task>`       |

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
- Workflow execution can cap parallelism and enable fail-fast batch stopping.
- Nodes can declare bounded retries, retry reasons, backoff, and execution
  timeouts.
- Agent self-reporting is not enough to pass deterministic gates.
- JSON Schema gates validate structure only. Use `verdict` and `acceptance`
  gates to enforce semantic pass/fail and per-criterion coverage.
- Command hooks support host policy controls, sanitized environments, timeouts,
  output limits, and JSON payloads on stdin.

## App-Facing API

External apps can import the stable config, planner, and runtime surfaces
without deep-importing private source paths:

```ts
import {
  loadPipelineConfig,
  parsePipelineConfigParts,
} from "@oisincoveney/pipeline/config";
import { compileWorkflowPlan } from "@oisincoveney/pipeline/planner";
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
