---
id: PIPE-19.1
title: Design and validate the YAML pipeline config model
status: Done
assignee: []
created_date: '2026-05-24 14:17'
updated_date: '2026-05-25 08:48'
labels:
  - pipeline
  - config
  - schema
dependencies: []
references:
  - src/mastra/config.ts
  - src/pipeline-spec.ts
parent_task_id: PIPE-19
priority: high
ordinal: 20000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Define the public `.pipeline/pipeline.yaml` contract for the clean redesign. The config must be YAML-only and must describe runners, agents, rules, skills, MCP servers, hooks, workflows, nodes, gates, retries, artifacts, and output contracts without relying on legacy profiles or hardcoded phase names. This task should produce the parser/validator behavior and test fixtures needed by later runtime work.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The config loader accepts `.pipeline/pipeline.yaml` as the only supported project pipeline config file.
- [x] #2 Validation fails with actionable errors for missing runners, missing agents, missing workflow node references, duplicate ids, invalid `needs` references, unsupported node kinds, unsupported hook events, and unsupported runner capabilities.
- [x] #3 Rules, skills, MCP servers, hooks, runners, agents, and workflows can be declared at top level and referenced by id from agents or workflows.
- [x] #4 Agent capability grants can express instructions, rules, skills, MCP server access, tools, filesystem policy, network policy, and output schemas.
- [x] #5 Tests cover valid config, invalid references, invalid capability grants, missing files, and YAML parse errors.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented YAML-only .pipeline/pipeline.yaml config loading and validation with strict runner, agent, registry, hook, workflow, capability, and file-reference checks. Removed the legacy profile resolver path from active source/tests and added coverage for valid config, missing/legacy config, malformed YAML, invalid references, unsupported grants, and ticket parsing.
<!-- SECTION:FINAL_SUMMARY:END -->
