# YAML Pipeline Architecture

The v1 runtime pipeline is package-owned config. Package-owned defaults declare
runner adapters, profiles, MCP gateway backends, the orchestrator profile,
entrypoints, schedules, hooks, workflows, gates, artifacts, OpenCode host
resources, and internal goal-loop continuation behavior. OpenCode is the package
runtime.

Runtime code does not read `.pipeline/config.toml`, phase profiles, or hardcoded
prompt constants.

## Complete Default Shape

`moka init` does not write this YAML into repositories. The runtime loads this
shape from the installed package defaults.

Default runners:

```yaml
version: 1

runners:
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      rules: true
      skills: true
      mcp_servers: true
      tools: [read, list, grep, glob, bash, edit, write]
      filesystem: [read-only, workspace-write]
      network: [inherit]
      output_formats: [text, json, jsonl, json_schema]
```

Default profiles:

```yaml
version: 1

rules:
  test-first:
    path: .pipeline/rules/test-first.md

skills: {}
mcp_servers: {}

profiles:
  orchestrator:
    runner: opencode
    instructions:
      path: .pipeline/prompts/orchestrator.md
    rules: [test-first]
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
  moka-researcher:
    runner: opencode
    instructions:
      path: .pipeline/prompts/researcher.md
    rules: [test-first]
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
    output:
      format: json_schema
      schema_path: .pipeline/schemas/research.schema.json
```

Package-owned workflow defaults:

```yaml
version: 1
default_workflow: default

entrypoints:
  quick:
    schedule: quick-schedule
    description: Compact planner-generated pipeline for small work
  execute:
    schedule: execute-schedule
    description: Full planner-generated pipeline for repository work
  inspect:
    workflow: inspect
    description: Read-only repository inspection

orchestrator:
  profile: orchestrator

hooks:
  functions: {}
  on: {}

scheduler:
  commands:
    quick:
      schedule: quick-schedule
      catalog: quick
    execute:
      schedule: execute-schedule
      catalog: execute

workflows:
  inspect:
    nodes:
      - id: inspect
        kind: agent
        profile: moka-inspector
  default:
    nodes:
      - id: research
        kind: agent
        profile: moka-researcher
      - id: verify
        kind: builtin
        builtin: test
        needs: [research]
```

Workflow execution settings are declared at the workflow level:

```yaml
workflows:
  default:
    execution:
      fail_fast: true
      max_parallel_nodes: 2
      timeout_ms: 600000
    nodes: []
```

`max_parallel_nodes` caps ready DAG nodes for that workflow. `fail_fast` stops
the current ready batch after the first failed node and marks the remaining
ready nodes as skipped. `timeout_ms` is normalized into the plan for callers
that want a workflow-wide budget; node execution still uses per-node
`timeout_ms`.

## Registries And Grants

Runner adapters live in `runners.yaml`. Profiles live in `profiles.yaml` and
receive explicit grants:

- `rules`: named markdown rule files.
- `skills`: named skill files.
- `mcp_gateway`: hosted or local ToolHive/vMCP gateway connection metadata.
- `mcp_servers`: profile grants should reference `pipeline-gateway` when MCP is
  needed.
- `tools`: allowed host tools only.
- `filesystem`: read-only or workspace-write plus allow/deny paths.
- `network`: inherited or disabled.
- `output`: text, JSON, JSONL, or JSON Schema output.

Default skills resolve from project-installed skill files created by
`moka init` via `npx --yes skills add oisin-ee/skills`:

```yaml
skills:
  verify:
    path: .agents/skills/verify/SKILL.md
```

Project-authored skill and rule paths resolve from the project root and must
exist for runtime use. If default skill files are missing, run `moka init` to
install them before executing workflows.

Default agent hooks are copied by `moka init` and `moka install-hooks` from the
private `oisin-ee/agent-hooks` repository. That source repository has one
canonical host-level layout:

```text
claude-code/
codex/
opencode/
```

Moka overlays those folders onto `.claude`, `.codex`, and `.opencode` for
project scope, or the corresponding per-machine host config directories for
global scope. Moka tracks installed hashes in host-local manifests so it can
update unchanged owned hook files, delete owned files removed from the hook
repository, and reject manual drift unless `--force` is used.

`moka init --skill-scope` (PIPE-83.12) chooses how the default set is installed:
`project` (default) vendors a repo-local copy (`skills add … --copy`,
`skills-lock.json`); `personal` installs once at user/global scope
(`skills add … --global`) so every repo the user opens inherits the skills with
no per-repo copy and no project lockfile — the standardization path for a single
user across many projects.

MCP-enabled profiles use one gateway grant:

```yaml
mcp_gateway:
  provider: toolhive
  mode: hosted
  url: https://pipeline-mcp.momokaya.ee/mcp/
  url_env: PIPELINE_MCP_GATEWAY_URL
  authorization_env: PIPELINE_MCP_GATEWAY_AUTHORIZATION
  default_profile: default

profiles:
  inspector:
    runner: opencode
    mcp_servers: [pipeline-gateway]
```

`moka init` renders generated OpenCode host config with exactly one
remote MCP server named `pipeline-gateway`. Upstream MCP servers are managed by
the ToolHive/vMCP gateway, not by OpenCode or pipeline worker sessions.

OpenCode host resources are generated from the same profile registry:

- `.opencode/agents/*.md` declares native agents with `mode`, `description`,
  resolved model, explicit permissions, and task access to generated agents only.
- `.opencode/skills/*/SKILL.md` is installed by `skills add`; Moka only
  generates agents, commands, plugins, and project config.
- Additional manually authored OpenCode hook plugins can be copied from
  `oisin-ee/agent-hooks/opencode/` by `moka install-hooks`.
- `.opencode/plugins/pipeline-goal-context.ts` projects package-owned
  continuation context into OpenCode compaction.
- `.opencode/opencode.json` contains the gateway MCP config, enables LSP, and
  lists pinned npm plugins from the curated stack.

LSP helps the OpenCode runtime inspect code, but it is not acceptance evidence.
Deterministic CLI gates, schema output validation, and verifier/acceptance
evidence remain the completion authority.

Goal state is a pipeline artifact, not a host-session artifact. The goal loop
records stop reasons, continuation prompts, verifier evidence, acceptance
coverage, violations, failed gates, and changed files. A `PASS` without both
deterministic verifier evidence and acceptance evidence is rejected even if an
OpenCode session summary says the work is done.

The curated default OpenCode stack currently includes the package-owned
`pipeline-goal-context` TypeScript plugin, pinned
`@devtheops/opencode-plugin-otel@1.1.0`, DCP code, `opencode-handoff`,
`opencode-background-agents`, `opencode-snip`, `opencode-mem`, and `cupcake`.
Official `@opencode-ai/sdk` and `@opencode-ai/plugin` are vetted candidates for
future native session integration, not automatic runtime dependencies.

JSON Schema outputs are hard contracts. The runtime validates normalized agent
output before the node can pass. Schema outputs also get a bounded repair pass
by default:

```yaml
output:
  format: json_schema
  schema_path: .pipeline/schemas/research.schema.json
  repair:
    enabled: true
    max_attempts: 1
```

The repair pass receives only the schema, invalid output, and validation error.
It uses a no-tools, read-only profile, then the runtime validates the repaired
output again. If repair still fails, the node fails with both original and
repair evidence.

Hooks live in `pipeline.yaml` and can be attached to the orchestrator, workflow,
or workflow nodes.

Entrypoints are stable app and CLI aliases for workflows. Runtime callers may
pass an entrypoint name instead of a workflow id; direct workflow selection is
kept for advanced callers and wins when both are supplied.

Validation fails when the orchestrator profile or a workflow node profile
references an undeclared registry item or asks a runner for an unsupported
capability. Projection never silently grants broader access than the YAML
requested.

## Gates, Artifacts, Retries, Hooks

Workflow nodes can declare:

```yaml
timeout_ms: 300000
retries:
  max_attempts: 2
  backoff_ms: 1000
  multiplier: 2
  retry_on: [exit_nonzero, gate_failure, timeout]
artifacts:
  - path: reports/verification.md
gates:
  - kind: command
    command: [bun, test]
    expect_exit_code: 0
  - kind: builtin
    builtin: typecheck
  - kind: json_schema
    target: stdout
    schema_path: .pipeline/schemas/verify.schema.json
  - kind: verdict
    target: stdout
    equals: PASS
  - kind: acceptance
    target: stdout
  - kind: changed_files
    changed_files:
      require_any: ["tests/**/*.test.ts"]
      deny: ["src/generated/**"]
hooks:
  - notify-start
```

Node shapes are strict and discriminated by `kind`: `agent` nodes require
`profile`, `command` nodes require `command`, `builtin` nodes require
`builtin`, and `group` nodes require `nodes`. Gate shapes follow the same
strict `kind` discriminator, so unrelated fields fail validation instead of
being ignored.

Retries default to retrying non-zero exits, required gate failures, and
timeouts when `max_attempts` is greater than one. `retry_on` narrows that set.
`backoff_ms` and `multiplier` apply between attempts. Per-node `timeout_ms`
overrides the generated agent subprocess timeout and command node timeout.
Internal node handoff uses validated runtime output, not repo-level artifact
files. Declare artifacts only for durable files that should remain inspectable
after the node runs.

Supported builtin gates are `test`, `typecheck`, and `duplication`.
`json_schema` remains structural; `verdict` checks configured JSON fields such
as `verdict: PASS`; `acceptance` compares normalized task context acceptance
criteria with structured review output; and `changed_files` enforces
project-configured RED/GREEN file policies.

Hooks run on workflow, node, and gate events with command or builtin callbacks.
Orchestrator workflow hooks run before workflow hooks. Required hook failure
blocks the workflow; optional hook failure is recorded as evidence. Command
hooks receive a JSON payload on stdin and can be constrained by host policy,
timeouts, output limits, sanitized env, and explicit trust flags.

## Host Support Matrix

| Runner      | Native subagents | Rules | Skills | MCP | Outputs                   | Generated resources             |
| ----------- | ---------------- | ----- | ------ | --- | ------------------------- | ------------------------------- |
| OpenCode    | yes              | yes   | yes    | yes | text, JSON, JSONL, schema | commands, agents, skills, plugins, LSP |
| Claude Code | via `opencode run` | yes (skill) | yes | yes | declared by runner | commands, wrapper agents, settings |
| command     | no               | no    | no     | no  | declared by runner        | subprocess argv                 |

Generated host resources follow a native runner rule. OpenCode runner nodes use
OpenCode native agents. The Claude Code host does not run MoKa profiles natively:
its generated `.claude/agents/moka-<role>.md` subagents each wrap a single
`opencode run --agent "MoKa <role>"` subprocess, so the OpenCode runner remains
the execution surface while Claude Code orchestrates. Unsupported runner or host
mappings fail closed instead of doing instruction-only translation or generic
worker substitution.

## Planning: Compile And Generate

Two distinct planning strategies turn config into an executable plan, and the
module layout names the distinction (`src/planning/`):

- `planning/compile.ts` — **deterministic DAG compilation**. `compileWorkflowPlan`
  validates a workflow's nodes (duplicate ids, missing dependencies, group
  references, cycles), normalizes group dependencies, and produces the
  `WorkflowExecutionPlan` (graph, topological order, parallel batches). This is
  the engine's mandatory front door: every execution path runs through it,
  including AI-generated schedules. Exposed as the `./planner` package subpath.
- `planning/generate.ts` — **optional AI decomposition**. `generateScheduleArtifact`
  drives a planner profile to decompose a task into a schedule artifact, then
  normalizes it through auditable passes (coverage → models → ids → references)
  and finally feeds it back into `compileScheduleArtifact`, which merges the
  generated workflows into config and calls `compileWorkflowPlan`. So generate
  output is always an input to compile — never a substitute for it. Exposed as
  the `./schedule` package subpath.

Both layers share one policy-free traversal model, `planning/graph.ts`
(`flattenNodes`, `dependentsByNeed`, `hasReachableDependent`, `findNode`,
`findDependencyCycles`). Each caller supplies its own predicates and owns its
error vocabulary, so config validation, deterministic compile, and AI-schedule
validation reason over the same graph structure without sharing layer-specific
policy. Schedule-specific support (artifact re-export barrel, baseline, prompts,
the normalization passes, backlog context, scheduling-role policy) stays under
`src/schedule/` and imports the artifact + generate API from `planning/generate`.

The toposort uses `@dagrejs/graphlib` for the graph model but an iterative
traversal for the topological sort, because graphlib's recursive topsort can
overflow the call stack on deep generated workflow chains.

## Context & durability features (PIPE-83)

The shipped `defaults/pipeline.yaml` turns **`context_handoff`, `repo_map`, and
`durability` ON** — moka uses its architecture by default; `parallel_worktrees`
is opt-in. Each block can be overridden in `pipeline.yaml`; the per-block
`# default …` notes below mark the *schema* default that applies when a block is
omitted entirely.

### `context_handoff` — curated node-to-node handoffs

```yaml
context_handoff:
  enabled: true          # default false
  model: openai/gpt-5.5-fast   # optional cheap model for the deriving call
```

When enabled, each agent node derives a structured `NodeHandoff`
(`summary`, `decisions`, `artifacts`, `testNames`, `openQuestions`) from its raw
output via a cheap read-only finalizer. Downstream nodes then receive that
curated handoff in their prompt instead of the upstream node's full transcript
(`renderAgentPrompt`), which kills the prompt-bloat from re-hydrating every
ancestor's output. When a node produces no handoff, consumers fall back to the
raw output text, so disabling the flag is byte-identical to prior behaviour.

### `parallel_worktrees` — isolated parallel children

```yaml
parallel_worktrees:
  enabled: true          # default false
```

When enabled, every child of a `kind: parallel` node runs in its own git
worktree on an auto-named branch (`.pipeline/worktrees/...`), so concurrent
candidate edits cannot collide. Teardown is idempotent and crash-safe: a
worktree with dirty or unpushed work is retained (never deleted), and orphaned
worktrees are GC'd on the next parallel node under the same guard. A worktree is
*not* a sandbox (node_modules/build state are shared) — real isolation remains
k8s mode. SDK-runner nodes honour the per-child directory via `plan.cwd`.

### `durability` — durable crash-resume

```yaml
durability:
  enabled: true              # default false
  dir: .pipeline/journal     # default
```

When enabled, the scheduler journals each terminal node result to an
append-only JSONL log under `dir`, keyed by run id (`<dir>/<runId>.jsonl`). A
killed run, re-invoked with the same run id, resumes from the last **passed**
node — finished nodes are not re-run and their tokens are not re-spent — while a
failed node and everything downstream replay so fail-fast and blocked-descendant
handling stay live. The journal is a swappable seam (`RunJournal`): the shipped
`fileRunJournal` needs zero external infra; a future `@effect/workflow` / cluster
provider can implement the same interface without touching the scheduler. Off by
default → the scheduler runs purely in-memory, exactly as before.

### `mcp_gateway.host_scope` — register the gateway once globally

```yaml
mcp_gateway:
  provider: toolhive
  mode: hosted
  host_scope: global       # default "project"
```

The singleton pipeline gateway is normally synthesized into each repo's
`.opencode/opencode.json` (`host_scope: project`, the default — unchanged
goldens). Setting `host_scope: global` stops that per-project synthesis: the
generated project config omits the `pipeline-gateway` MCP entry and instead
inherits one global registration written once via
`moka gateway configure-host --scope global` (which targets
`$OPENCODE_CONFIG_DIR`/`$XDG_CONFIG_HOME/opencode/opencode.json`). This is the
PIPE-83.11 standardization path — register the MCP gateway once per machine
rather than re-emitting it into every project.

## Troubleshooting

- Missing host resources: run `moka install-commands`; `moka run` loads the
  installed package config.
- Capability error: reduce the profile grants or choose a runner whose declared
  capabilities include the requested tools, filesystem, network, output, rules,
  skills, or MCP access.
- Gate failure: inspect `moka run` output for node, gate, reason, and evidence.
  Dependent nodes are not executed after a required gate fails.
- Schema failure: ensure the agent emits valid JSON and that `schema_path`
  points to a JSON Schema file in the target worktree.
