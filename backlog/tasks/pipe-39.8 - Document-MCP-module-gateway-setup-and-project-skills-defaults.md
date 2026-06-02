---
id: PIPE-39.8
title: 'Document MCP module, gateway setup, and project skills defaults'
status: Done
assignee: []
created_date: '2026-06-02 16:34'
updated_date: '2026-06-02 20:46'
labels:
  - docs
  - mcp
  - skills
  - gateway
dependencies:
  - PIPE-39.3
  - PIPE-39.7
references:
  - README.md
  - docs/mcp-host-isolation.md
  - .pipeline/profiles.yaml
  - src/mcp
modified_files:
  - README.md
  - docs/mcp.md
  - docs/mcp-gateway.md
parent_task_id: PIPE-39
priority: medium
ordinal: 72000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Update operator and contributor documentation so future agents know where MCP code lives, how gateway MCP endpoints should be configured, and why skills are installed into .agents/skills with npx skills add oisincoveney/skills.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 README prerequisites and init instructions say pipe init installs default skills with npx skills add oisincoveney/skills.
- [x] #2 Documentation explains the src/mcp boundary: bootstrap/default registration, runtime launch planning, native generated-agent projection, and host isolation policy.
- [x] #3 Documentation includes a role-scoped remote gateway MCP example for orchestrator/research/verify profiles using url plus bearer_token_env_var, and explicitly discourages one giant all-tools gateway.
- [x] #4 Documentation states the npx skills add oisincoveney/skills installer and the canonical .agents/skills path shape.
- [x] #5 pipe validate or equivalent documented check passes after pipe init installs .agents/skills.
<!-- AC:END -->



## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Update README and add docs/mcp-gateway.md or docs/mcp.md. Include examples for .pipeline/profiles.yaml remote gateway entries, Codex/OpenCode notes from the isolation research, and the project skills installation requirement. Run focused docs/config validation tests after implementation.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented as part of PIPE-39. Verification: bun run check passed; bun run typecheck passed; bun run test passed with 279 tests passing and 15 live-runner tests skipped.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Focused tests or documented research evidence cover the ticket acceptance criteria.
- [x] #2 Relevant project verification command is run and its result is recorded in the task final summary.
- [x] #3 Diff is reviewed for unrelated edits, unsafe casts/assertions, disabled checks, and shallow glue before marking done.
<!-- DOD:END -->
