---
id: PIPE-16
title: Expose pipeline primitive through slash-command and CLI adapters
status: Done
assignee: []
created_date: '2026-05-21 10:43'
updated_date: '2026-05-21 22:05'
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
- [x] #1 A reusable pipeline primitive can run the research, RED, GREEN, VERIFY, and LEARN lifecycle without depending directly on shell-specific harness subprocesses.
- [x] #2 The existing CLI entrypoint uses a subprocess-based adapter and continues to support the documented `work-next` behavior.
- [x] #3 A slash-command adapter contract is documented for Claude Code, Codex, OpenCode, and Pi, including how each host supplies task input, target path, agent execution, and phase reporting.
- [x] #4 At least one repository slash-command definition or template is added that invokes the pipeline primitive without requiring users to assemble environment-variable commands manually.
- [x] #5 Tests prove the pipeline primitive works with an in-process fake agent adapter and that the CLI adapter still uses real subprocess execution for the existing tracer path.
- [x] #6 README documents both invocation modes and clearly explains when to use slash commands versus the CLI.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Completed native-agent resource repair on 2026-05-22. The CLI path still uses runPipelinePrimitive with the subprocess adapter for direct harness CLI calls. The generated host path now uses each host's own resource mechanics: Claude Code command plus project agents, OpenCode command plus primary/subagent definitions, Codex skill plus .codex agent definitions with $work-next invocation, and Pi project extension that registers /work-next and dispatches pi-subagents /chain. The prior local commit that replaced mechanics with prompt-only claims was removed before implementation. Generated resources are dogfooded in this repository and installer --check is stable.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Refactored generated host command installation around a shared pipeline spec and real host agent resources instead of CLI shell wrappers or prose-only fake native claims. Added Claude project agents, OpenCode primary/subagent resources, Codex skill plus Codex agent definitions, and a Pi extension that registers /work-next and dispatches a pi-subagents /chain. Updated README and slash-command contract docs to describe the actual invocation mechanics, including Codex $work-next instead of unsupported custom slash commands. Added installer tests that verify generated resources configure host agents and do not shell out to work-next. Verified with full tests, typecheck, Ultracite check, build, install-commands --check, npm pack dry-run, and host discovery checks for Claude, Codex, OpenCode, and Pi.
<!-- SECTION:FINAL_SUMMARY:END -->
