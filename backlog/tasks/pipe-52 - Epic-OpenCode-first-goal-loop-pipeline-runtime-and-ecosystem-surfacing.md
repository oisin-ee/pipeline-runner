---
id: PIPE-52
title: 'Epic: OpenCode-first goal-loop pipeline runtime and ecosystem surfacing'
status: To Do
assignee: []
created_date: '2026-06-08 19:00'
labels:
  - epic
  - opencode
  - goal-loop
dependencies: []
references:
  - README.md
  - docs/config-architecture.md
  - docs/mcp-gateway.md
  - 'https://opencode.ai/docs/ecosystem'
  - 'https://github.com/awesome-opencode/awesome-opencode'
priority: high
ordinal: 145000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make OpenCode the default pipeline runtime, add persistent goal/continuation/verification-loop semantics inspired by OmO/ultrawork while preserving explicit pipeline schedules and deterministic gates, and ship a curated package-owned OpenCode stack with the relevant plugins, MCP servers, skills, prompts, LSP, permissions, and policy surfaces enabled by default when they are safe to include.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Package defaults run built-in pipeline profiles through OpenCode by default while Codex remains a supported compatibility runner.
- [ ] #2 Pipeline runs persist goal state and use verifier/acceptance evidence, not agent self-reporting, to decide completion.
- [ ] #3 Continuation prompts can resume unfinished goals with bounded stop conditions and real failure evidence.
- [ ] #4 Scheduler can generate auditable team-mode-style DAGs instead of hidden dynamic agent teams.
- [ ] #5 Relevant OpenCode ecosystem plugins, DCP code, MCP servers, skills, prompts, LSP, permissions, and policy surfaces are documented and included in the package-owned default stack.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Drain child tasks in dependency order. First decide architecture and extension policy, then implement OpenCode defaults and goal-state contract, then build continuation/verification/team scheduling, then project host resources and ecosystem manifest, then run real repository usage verification.
<!-- SECTION:PLAN:END -->
