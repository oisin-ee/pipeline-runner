# YAML Pipeline Architecture

The v1 pipeline is YAML-only and is split into three required files:

- `.pipeline/runners.yaml` declares runner adapters and capabilities.
- `.pipeline/profiles.yaml` declares reusable profiles, rules, skills, and MCP servers.
- `.pipeline/pipeline.yaml` declares the orchestrator profile, hooks, workflows, gates, and artifacts.

Runtime code does not read `.pipeline/config.toml`, phase profiles, or hardcoded
prompt constants.

## Complete Default Shape

`pipe init` writes the default workflow with this shape.

`.pipeline/runners.yaml`:

```yaml
version: 1

runners:
  codex:
    type: codex
    command: codex
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

`.pipeline/profiles.yaml`:

```yaml
version: 1

rules:
  test-first:
    path: .pipeline/rules/test-first.md

skills: {}
mcp_servers: {}

profiles:
  orchestrator:
    runner: codex
    instructions:
      path: .pipeline/prompts/orchestrator.md
    rules: [test-first]
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
  pipeline-researcher:
    runner: codex
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

`.pipeline/pipeline.yaml`:

```yaml
version: 1
default_workflow: default

orchestrator:
  profile: orchestrator
  hooks: []

hooks: {}

workflows:
  inspect:
    nodes:
      - id: inspect
        kind: agent
        profile: pipeline-inspector
  default:
    nodes:
      - id: research
        kind: agent
        profile: pipeline-researcher
      - id: verify
        kind: builtin
        builtin: test
        needs: [research]
```

## Registries And Grants

Runner adapters live in `runners.yaml`. Profiles live in `profiles.yaml` and
receive explicit grants:

- `rules`: named markdown rule files.
- `skills`: named skill files.
- `mcp_servers`: named MCP command definitions.
- `tools`: allowed host tools only.
- `filesystem`: read-only or workspace-write plus allow/deny paths.
- `network`: inherited or disabled.
- `output`: text, JSON, JSONL, or JSON Schema output.

Hooks live in `pipeline.yaml` and can be attached to the orchestrator, workflow,
or workflow nodes.

Validation fails when the orchestrator profile or a workflow node profile
references an undeclared registry item or asks a runner for an unsupported
capability. Projection never silently grants broader access than the YAML
requested.

## Gates, Artifacts, Retries, Hooks

Workflow nodes can declare:

```yaml
retries:
  max_attempts: 2
artifacts:
  - path: .pipeline/research.json
gates:
  - kind: command
    command: [bun, test]
    expect_exit_code: 0
  - kind: builtin
    builtin: typecheck
  - kind: json_schema
    target: stdout
    schema_path: .pipeline/schemas/verify.schema.json
hooks:
  - notify-start
```

Supported builtin gates are `test`, `typecheck`, and `duplication`. Hooks run on
workflow, node, and gate events with command or builtin callbacks. Required hook
failure blocks the workflow; optional hook failure is recorded as evidence.

## Host Support Matrix

| Runner | Native subagents | Rules | Skills | MCP | Outputs | Generated resources |
| --- | --- | --- | --- | --- | --- | --- |
| Claude | yes | yes | projected as text when declared | yes | text, JSON, schema | command plus `.claude/agents` |
| Codex | yes | yes | yes | yes | text, JSON, JSONL, schema | skill plus `.codex/agents` |
| OpenCode | yes | yes | projected as text when declared | yes | text, JSON, JSONL, schema | command plus `.opencode/agents` |
| Kimi | yes | yes | projected as text when declared | no | text, JSON | command plus `.kimi/agents` |
| Pi | yes, with pi-subagents | yes | projected as text when declared | no | text, JSON | extension plus prompt |
| command | no | no | no | no | declared by runner | subprocess argv |

The runtime prefers native subagents when the runner advertises
`native_subagents: true` and the configured permissions, runner, output, and
resource grants can be represented safely. Otherwise it uses a subprocess for
the agent node. In both cases each agent node records a separate invocation
boundary; multi-agent workflows are never collapsed into one prompt.

## Troubleshooting

- Missing config: run `pipe init`; `pipe run` requires
  `.pipeline/pipeline.yaml`, `.pipeline/profiles.yaml`, and
  `.pipeline/runners.yaml`.
- Capability error: reduce the profile grants or choose a runner whose declared
  capabilities include the requested tools, filesystem, network, output, rules,
  skills, or MCP access.
- Pi native execution error: install and enable `pi-subagents`; generated Pi
  resources check for its commands before sending a chain.
- Gate failure: inspect `pipe run` output for node, gate, reason, and evidence.
  Dependent nodes are not executed after a required gate fails.
- Schema failure: ensure the agent emits valid JSON and that `schema_path`
  points to a JSON Schema file in the target worktree.
