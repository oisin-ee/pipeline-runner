# Slash Command Adapter Contract

The reusable primitive is `runPipelinePrimitive(input, adapters)` from
`src/mastra/pipeline-primitive.ts`. Slash-command hosts call that primitive with
an in-process `AgentAdapter`; the shell CLI calls the same primitive with the
subprocess adapter from `src/mastra/runner.ts`.

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
| Claude Code | `$ARGUMENTS` from `.claude/commands/work-next.md` | current project directory | `Task` tool/subagent invocation for each requested role | command transcript plus optional `PipelinePhaseReporter` messages |
| Codex | slash prompt arguments | current workspace root | in-session delegated agent/tool call implementing `AgentAdapter.run` | command transcript plus optional `PipelinePhaseReporter` messages |
| OpenCode | command arguments | active project directory | OpenCode native agent/session call for the requested role | host run log plus optional `PipelinePhaseReporter` messages |
| Pi | command arguments | active project directory | Pi RPC session message per role using the adapter request payload | RPC events plus optional `PipelinePhaseReporter` messages |

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
