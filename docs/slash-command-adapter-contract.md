# Host Resource Adapter Contract

Generated host resources are derived from `.pipeline/runners.yaml`,
`.pipeline/profiles.yaml`, and `.pipeline/pipeline.yaml`. They do not maintain
independent profile definitions or silently translate one runner into another
host's default agent.

Install or check generated resources with:

```sh
pipe install-commands --host all
pipe install-commands --host all --check
```

## Host Mappings

| Host        | Generated resources                                               | Invocation                         | Mechanical path                                                                                        |
| ----------- | ----------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Claude Code | `.claude/commands/<entrypoint>.md`, `.claude/agents/*.md`         | `/pipe <task>`, `/inspect <task>`  | Project commands delegate to configured Claude agents.                                                 |
| Codex       | `.agents/skills/<entrypoint>/SKILL.md`, `.codex/agents/*.toml`    | `$pipe <task>`, `$inspect <task>`  | Skills instruct Codex to use generated Codex agents for Codex runner nodes.                            |
| OpenCode    | `.opencode/commands/<entrypoint>.md`, `.opencode/agents/*.md`     | `/pipe <task>`, `/inspect <task>`  | Project commands run a primary orchestrator and native subagents when the requested model is resolved. |
| Kimi        | `.kimi/commands/<entrypoint>.md`, `.kimi/agents/*.yaml`           | `/pipe <task>`, `/inspect <task>`  | Kimi discovers generated command surfaces directly; Kimi agents are generated as YAML specs.           |
| Pi          | `.pi/prompts/<entrypoint>.md`                                     | `/pipe <task>`, `/inspect <task>`  | Pi discovers project prompt templates as slash commands.                                               |

## Projection Rules

- Profile names, descriptions, instructions, tools, rules, skills, MCP servers,
  filesystem mode, network mode, and output contracts are read from YAML.
- Exact native dispatch is used when a node runner matches the host.
- OpenCode can run mixed native subagents when the node runner has a resolved
  model from `profile.host_models.opencode`, `runner.host_models.opencode`,
  `profile.model`, or `runner.model`.
- Cross-runner nodes that cannot be represented natively are dispatched through
  that runner's CLI. Instruction-only translation is not runner-correct and is
  not used as an implicit fallback.
- Host-specific formats can omit unsupported capabilities, but they must not
  grant broader access than requested.
- Regeneration is idempotent for generated files. Manual edits are protected
  unless `--force` is supplied.

The CLI runtime and generated host resources share the same workflow plan. Multi-agent
workflows require separate agent boundaries; host resources must not collapse
the workflow into a single prompt.
