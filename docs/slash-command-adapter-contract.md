# Host Resource Adapter Contract

Generated host resources are derived from package-owned
`@oisincoveney/pipeline` config. They do not maintain independent profile
definitions or silently translate one runner into another host's default agent.

Install generated resources during setup, then check drift with:

```sh
moka init
moka install-commands --host all --check
```

## Host Mappings

| Host     | Generated resources                                            | Invocation                        | Mechanical path                                                                                       |
| -------- | -------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| OpenCode | `.opencode/commands/moka-<entrypoint>.md`, `.opencode/agents/*.md`, `.opencode/opencode.json` | `/moka-quick <task>`, `/moka-execute <task>`, `/moka-inspect <task>` | Project commands run a primary orchestrator and OpenCode native subagents with package-owned skill, MCP, permission, and LSP projection. |
| Claude Code | `.claude/commands/moka-<entrypoint>.md`, `.claude/agents/moka-<role>.md`, `.claude/settings.json` | `/moka-quick <task>`, `/moka-execute <task>`, `/moka-inspect <task>` | Slash commands load the `execute` skill, then dispatch each agent node to a Claude Code `Task` subagent that wraps a single `opencode run --agent "MoKa <role>"` subprocess. `.claude/settings.json` is merged (gateway MCP + `Bash(opencode run *)` permission), never clobbered. |

## Projection Rules

- Profile names, descriptions, instructions, tools, rules, skills, MCP servers,
  filesystem mode, network mode, and output contracts are read from YAML.
- Scheduled entrypoints generate a reviewable schedule artifact first and do not
  execute workflow nodes until `moka run --schedule <schedule.yaml>` is invoked.
- OpenCode runner nodes are OpenCode native agents.
- Unsupported runner or host mappings fail closed. Instruction-only translation
  and generic worker substitution are not used as implicit fallbacks.
- Host-specific formats can omit unsupported capabilities, but they must not
  grant broader access than requested.
- OpenCode agents project package profiles as markdown agents with `mode`,
  `description`, resolved `model`, `permission`, `hidden`, and task permission
  maps. The primary orchestrator may call only generated package profile agents.
- OpenCode skill files are installed by `npx skills add` during `moka init`;
  Moka does not generate `.opencode/skills`. Generated agent
  `permission.skill` maps still deny ungranted skills.
- `.opencode/opencode.json` includes the singleton `pipeline-gateway` MCP
  server and enables OpenCode LSP. CLI lint, typecheck, tests, and configured
  gates remain the blocking verification path; LSP is editor/runtime assistance.
- Regeneration is idempotent for generated files. Manual edits are protected
  unless `--force` is supplied.

The CLI runtime and generated host resources share either the same static
workflow plan or the same approved schedule artifact. Multi-agent workflows
require separate agent boundaries; host resources must not collapse the workflow
into a single prompt.
