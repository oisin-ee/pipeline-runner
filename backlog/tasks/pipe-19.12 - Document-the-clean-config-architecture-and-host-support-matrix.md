---
id: PIPE-19.12
title: Document the clean config architecture and host support matrix
status: To Do
assignee: []
created_date: '2026-05-24 14:18'
updated_date: '2026-05-24 14:18'
labels:
  - pipeline
  - docs
dependencies:
  - PIPE-19.1
  - PIPE-19.5
  - PIPE-19.6
  - PIPE-19.7
  - PIPE-19.8
  - PIPE-19.9
  - PIPE-19.10
  - PIPE-19.11
references:
  - README.md
  - docs
parent_task_id: PIPE-19
priority: medium
ordinal: 31000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Write user-facing and maintainer-facing documentation for the new YAML-only pipeline architecture. The docs must explain how to declare runners, agents, workflows, skills, MCP servers, rules, hooks, gates, and host-specific native multi-agent support without referencing removed profile behavior as the recommended path.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Docs include a complete default pipeline YAML example and a minimal custom workflow example.
- [ ] #2 Docs explain top-level registries versus per-agent grants for rules, skills, MCP servers, tools, filesystem, and network policies.
- [ ] #3 Docs include a host support matrix for Claude, Codex, OpenCode, Kimi, Pi, and command runners.
- [ ] #4 Docs explain native-preferred execution and the guarantee that multi-agent workflows use real separate agent boundaries.
- [ ] #5 Docs include troubleshooting guidance for config validation, missing host capabilities, missing Pi subagents support, gate failures, and schema output failures.
<!-- AC:END -->
