# YAML Pipeline Architecture

The v1 pipeline is YAML-only. `.pipeline/pipeline.yaml` is loaded, validated,
compiled into a deterministic DAG, and then executed by `pipe run`. Runtime code
does not read `.pipeline/config.toml`, phase profiles, or hardcoded prompt
constants.

## Complete Default Shape

`pipe init` writes the default workflow with these top-level registries:

```yaml
version: 1
default_workflow: default

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

rules:
  test-first:
    path: .pipeline/rules/test-first.md

skills: {}
mcp_servers: {}
hooks: {}

orchestrator:
  runner: codex
  instructions:
    path: .pipeline/prompts/orchestrator.md
  rules: [test-first]
  tools: [read, list, grep, glob, bash]
  filesystem:
    mode: read-only
  network:
    mode: inherit
  hooks: []

agents:
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

workflows:
  default:
    nodes:
      - id: research
        kind: agent
        agent: pipeline-researcher
      - id: verify
        kind: builtin
        builtin: test
        needs: [research]
```

## Registries And Grants

Top-level registries declare resources. The required `orchestrator` block and
each agent receive explicit grants:

- `rules`: named markdown rule files.
- `skills`: named skill files.
- `mcp_servers`: named MCP command definitions.
- `tools`: allowed host tools only.
- `filesystem`: read-only or workspace-write plus allow/deny paths.
- `network`: inherited or disabled.
- `hooks`: orchestrator or workflow lifecycle hooks.
- `output`: agent-only text, JSON, JSONL, or JSON Schema output.

Validation fails when the orchestrator or an agent references an undeclared
registry item or asks a runner for an unsupported capability. Projection never
silently grants broader access than the YAML requested.

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
  `.pipeline/pipeline.yaml`.
- Capability error: reduce the agent grants or choose a runner whose declared
  capabilities include the requested tools, filesystem, network, output, rules,
  skills, or MCP access.
- Pi native execution error: install and enable `pi-subagents`; generated Pi
  resources check for its commands before sending a chain.
- Gate failure: inspect `pipe run` output for node, gate, reason, and evidence.
  Dependent nodes are not executed after a required gate fails.
- Schema failure: ensure the agent emits valid JSON and that `schema_path`
  points to a JSON Schema file in the target worktree.
