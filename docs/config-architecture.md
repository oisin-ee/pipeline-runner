# YAML Pipeline Architecture

The v1 pipeline is YAML-only and is split into three required files:

- `.pipeline/runners.yaml` declares runner adapters and capabilities.
- `.pipeline/profiles.yaml` declares reusable profiles, rules, skills, and MCP servers.
- `.pipeline/pipeline.yaml` declares the orchestrator profile, entrypoints, hooks, workflows, gates, and artifacts.

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
    model: gpt-5.5
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

entrypoints:
  pipe:
    workflow: default
    description: Full pipeline

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
- `mcp_servers`: named MCP server definitions. Servers may be local stdio
  commands or remote streamable HTTP endpoints.
- `tools`: allowed host tools only.
- `filesystem`: read-only or workspace-write plus allow/deny paths.
- `network`: inherited or disabled.
- `output`: text, JSON, JSONL, or JSON Schema output.

MCP servers support two strict shapes:

```yaml
mcp_servers:
  docs:
    command: npx
    args: ["-y", "@example/docs-mcp"]
    env:
      DOCS_TOKEN: token
  memory:
    url: https://memory-mcp.momokaya.ee/mcp/
    bearer_token_env_var: MEMORY_MCP_TOKEN
    headers:
      X-Memory-Region: eu
```

Exactly one of `command` or `url` is required. `args` and `env` apply only to
command servers. `headers` and `bearer_token_env_var` apply only to URL
servers.

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

| Runner   | Native subagents       | Rules | Skills                                        | MCP | Outputs                   | Generated resources              |
| -------- | ---------------------- | ----- | --------------------------------------------- | --- | ------------------------- | -------------------------------- |
| Claude   | yes                    | yes   | included in generated profile text            | yes | text, JSON, schema        | command plus `.claude/agents`    |
| Codex    | yes                    | yes   | yes                                           | yes | text, JSON, JSONL, schema | skill plus `.codex/agents`       |
| OpenCode | yes                    | yes   | included in generated profile text            | yes | text, JSON, JSONL, schema | command plus `.opencode/agents`  |
| Kimi     | yes                    | yes   | surfaced through project skills when declared | no  | text, JSON                | skill plus `.kimi/agents/*.yaml` |
| Pi       | yes, with pi-subagents | yes   | included in generated prompt text             | no  | text, JSON                | prompt plus no-op extension shim |
| command  | no                     | no    | no                                            | no  | declared by runner        | subprocess argv                  |

The runtime prefers native subagents when the runner advertises
`native_subagents: true` and the configured permissions, runner, output, and
resource grants can be represented safely. Otherwise it uses a subprocess for
the agent node. In both cases each agent node records a separate invocation
boundary; multi-agent workflows are never collapsed into one prompt.

Generated host resources follow a native-first, runner-correct rule. Same-host
agent nodes use exact native subagents. Cross-runner nodes use host-native
execution only when the host can explicitly run the requested model; OpenCode
does this through per-agent `model:` values resolved from profile or runner
`model`, with optional `host_models.opencode` overrides when model ids differ.
If native execution cannot represent the requested runner/model, generated
instructions dispatch to that runner's CLI instead of doing instruction-only
translation.

## Troubleshooting

- Missing config: run `pipe init`; `pipe run` requires
  `.pipeline/pipeline.yaml`, `.pipeline/profiles.yaml`, and
  `.pipeline/runners.yaml`.
- Capability error: reduce the profile grants or choose a runner whose declared
  capabilities include the requested tools, filesystem, network, output, rules,
  skills, or MCP access.
- Pi native execution unavailable: install and enable `pi-subagents` if you want
  Pi-native chains. Otherwise `/pipe` uses the CLI dispatch instructions in the
  generated Pi prompt.
- Gate failure: inspect `pipe run` output for node, gate, reason, and evidence.
  Dependent nodes are not executed after a required gate fails.
- Schema failure: ensure the agent emits valid JSON and that `schema_path`
  points to a JSON Schema file in the target worktree.
