---
description: Run the oisin pipeline primitive for a task
argument-hint: "<ticket id or task description>"
allowed-tools: Task, Read, Write, Edit, MultiEdit, Glob, Grep, LS, Bash(bun run test:*), Bash(bun run typecheck:*), Bash(bun run check:*)
---

Run the repository pipeline primitive for:

```
$ARGUMENTS
```

Use `runPipelinePrimitive()` from `src/mastra/pipeline-primitive.ts` with a
Claude Code in-process `AgentAdapter`. Do not ask the user to assemble
`PIPELINE_HARNESS` or `PIPELINE_TARGET_PATH`.

Adapter mapping:

- `task`: `$ARGUMENTS`
- `worktreePath`: this repository root
- `harness`: `claude`
- `AgentAdapter.run`: invoke the native Claude Code `Task` tool for the
  requested role (`researcher`, `test-writer`, `code-writer`, `verifier`) using
  the supplied prompt and context file.
- `PipelinePhaseReporter`: report `research`, `red`, `green`, `verify`, and
  `learn` starts/completions in the command transcript.

The primitive owns the phase order, RED/GREEN/VERIFY gates, and learning write.
