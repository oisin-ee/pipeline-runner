---
id: PIPE-16
title: Expose pipeline primitive through slash-command and CLI adapters
status: To Do
assignee: []
created_date: '2026-05-21 10:43'
labels:
  - architecture
  - cli
  - slash-commands
  - agents
dependencies: []
references:
  - src/index.ts
  - src/mastra/runner.ts
  - src/mastra/workflows/pipeline.ts
  - README.md
  - tests/tracer-bullet.test.ts
priority: high
ordinal: 16000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Refactor the current CLI-centric pipeline into a reusable pipeline primitive that can be invoked either from slash commands inside Claude Code, Codex, OpenCode, or Pi using the host interface's native subagent/session capabilities, or from a shell CLI using subprocess harness commands. The pipeline behavior should stay the same, but agent execution and phase reporting must become injectable adapters rather than hardwired CLI subprocess behavior.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A reusable pipeline primitive can run the research, RED, GREEN, VERIFY, and LEARN lifecycle without depending directly on shell-specific harness subprocesses.
- [ ] #2 The existing CLI entrypoint uses a subprocess-based adapter and continues to support the documented `work-next` behavior.
- [ ] #3 A slash-command adapter contract is documented for Claude Code, Codex, OpenCode, and Pi, including how each host supplies task input, target path, agent execution, and phase reporting.
- [ ] #4 At least one repository slash-command definition or template is added that invokes the pipeline primitive without requiring users to assemble environment-variable commands manually.
- [ ] #5 Tests prove the pipeline primitive works with an in-process fake agent adapter and that the CLI adapter still uses real subprocess execution for the existing tracer path.
- [ ] #6 README documents both invocation modes and clearly explains when to use slash commands versus the CLI.
<!-- AC:END -->
