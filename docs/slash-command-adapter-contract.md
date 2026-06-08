# Host Resource Adapter Contract

Generated host resources are derived from package-owned
`@oisincoveney/pipeline` config. They do not maintain independent profile
definitions or silently translate one runner into another host's default agent.

Install or check generated resources with:

```sh
pipe install-commands --host all
pipe install-commands --host all --check
```

## Host Mappings

| Host     | Generated resources                                            | Invocation                        | Mechanical path                                                                                       |
| -------- | -------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Codex    | `.agents/skills/<entrypoint>/SKILL.md`, `.codex/agents/*.toml` | `$pipe <task>`, `$inspect <task>` | Skills instruct Codex to use generated Codex agents for Codex runner nodes and OpenCode CLI for OpenCode runner nodes. |
| OpenCode | `.opencode/commands/<entrypoint>.md`, `.opencode/agents/*.md`  | `/pipe <task>`, `/inspect <task>` | Project commands run a primary orchestrator and OpenCode native subagents.                            |

## Projection Rules

- Profile names, descriptions, instructions, tools, rules, skills, MCP servers,
  filesystem mode, network mode, and output contracts are read from YAML.
- Scheduled entrypoints generate a reviewable schedule artifact first and do not
  execute workflow nodes until `pipe run --schedule <schedule.yaml>` is invoked.
- Codex runner nodes are Codex native agents.
- OpenCode runner nodes are OpenCode native agents.
- Codex-hosted workflows dispatch OpenCode runner nodes through the OpenCode CLI.
- Unsupported runner or host mappings fail closed. Instruction-only translation
  and generic worker substitution are not used as implicit fallbacks.
- Host-specific formats can omit unsupported capabilities, but they must not
  grant broader access than requested.
- Regeneration is idempotent for generated files. Manual edits are protected
  unless `--force` is supplied.

The CLI runtime and generated host resources share either the same static
workflow plan or the same approved schedule artifact. Multi-agent workflows
require separate agent boundaries; host resources must not collapse the workflow
into a single prompt.
