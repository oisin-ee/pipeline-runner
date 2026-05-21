# Slash Command Adapter Contract

The reusable primitive is `runPipelinePrimitive(input, adapters)` from
`src/mastra/pipeline-primitive.ts`. Slash-command hosts call that primitive with
an in-process `AgentAdapter`; the shell CLI calls the same primitive with the
subprocess adapter from `src/mastra/runner.ts`.

For normal project installation, run:

```sh
bunx @oisincoveney/pipeline install-commands --host all
```

The installer writes generated command files into the current repository. Re-run
it after package updates. It is idempotent, supports `--dry-run`, supports
`--check`, and refuses to overwrite manually edited files unless `--force` is
passed.

## Primitive Input

Slash commands must supply:

- `task`: the command arguments or selected ticket text.
- `worktreePath`: the repository root or task worktree the host is currently
  editing.
- `harness`: the host name, one of `claude`, `codex`, `opencode`, or `pi`.

## Agent Adapter

The host adapter implements:

```ts
interface AgentAdapter {
  run(request: {
    contextFile: string | null;
    harness: "claude" | "codex" | "opencode" | "pi";
    prompt: string;
    role: "researcher" | "test-writer" | "code-writer" | "verifier";
    worktreePath: string;
  }): Promise<{ exitCode: number; stdout: string }>;
}
```

The primitive owns the phase order and gates. The adapter only maps each role to
the host's native execution mechanism.

## Host Mappings

| Host | Task input | Target path | Agent execution | Phase reporting |
| --- | --- | --- | --- | --- |
| Host | Generated file | Invocation |
| --- | --- | --- |
| Claude Code | `.claude/commands/work-next.md` | `/work-next <ticket id or task description>` |
| OpenCode | `.opencode/commands/work-next.md` | `/work-next <ticket id or task description>` |
| Pi | `.pi/prompts/work-next.md` | `/work-next <ticket id or task description>` |
| Codex | `.agents/skills/work-next/SKILL.md` | `/use work-next <ticket id or task description>` |

Codex currently does not support project-defined custom slash commands in the
same way as Claude Code and OpenCode, so the installer generates a project skill
instead of pretending that `/work-next` is available.

## Phase Reporter

Slash hosts may pass:

```ts
interface PipelinePhaseReporter {
  started?(phase: "research" | "red" | "green" | "verify" | "learn"): void | Promise<void>;
  completed?(phase: "research" | "red" | "green" | "verify" | "learn"): void | Promise<void>;
}
```

Use this for native UI updates. The primitive returns the same
`{ outcome, failureDetails }` shape used by the CLI.
