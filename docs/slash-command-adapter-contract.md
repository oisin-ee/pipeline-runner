# Host Resource Adapter Contract

Generated host resources are projections of `.pipeline/pipeline.yaml`. They do
not shell out to a legacy command and do not maintain independent agent
profiles.

Install or check generated resources with:

```sh
pipe install-commands --host all
pipe install-commands --host all --check
```

## Host Mappings

| Host | Generated resources | Invocation | Mechanical path |
| --- | --- | --- | --- |
| Claude Code | `.claude/commands/pipe.md`, `.claude/agents/*.md` | `/pipe <task>` | Project command delegates to configured Claude agents. |
| Codex | `.agents/skills/pipe/SKILL.md`, `.codex/agents/*.toml` | `$pipe <task>` | Skill instructs Codex to use generated Codex agents. |
| OpenCode | `.opencode/commands/pipe.md`, `.opencode/agents/*.md` | `/pipe <task>` | Project command runs a primary orchestrator and configured subagents. |
| Kimi | `.kimi/commands/pipe.md`, `.kimi/agents/*.md` | `/pipe <task>` | Project command and agent specs mirror YAML grants. |
| Pi | `.pi/extensions/pipe.ts`, `.pi/prompts/pipe.md` | `/pipe <task>` | Extension requires `pi-subagents` before sending a chain. |

## Projection Rules

- Agent names, descriptions, instructions, tools, rules, skills, MCP servers,
  filesystem mode, network mode, and output contracts are read from YAML.
- Host-specific formats can omit unsupported capabilities, but they must not
  grant broader access than requested.
- Regeneration is idempotent for generated files. Manual edits are protected
  unless `--force` is supplied.

The CLI runtime and host projections share the same workflow plan. Multi-agent
workflows require separate agent boundaries; host resources must not collapse
the workflow into a single prompt.
