---
id: PIPE-39
title: Modularize MCP scope and install default project skills
status: Done
assignee: []
created_date: "2026-06-02 16:33"
updated_date: "2026-06-02 20:45"
labels:
  - epic
  - mcp
  - skills
dependencies: []
priority: high
ordinal: 64000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Refactor oisin-pipeline so MCP selection/rendering/bootstrap logic lives behind a dedicated src/mcp module, while default skill configuration becomes opinionated around the project-installed .agents/skills via npx skills add oisincoveney/skills. Keep the package agent-agnostic: Codex and OpenCode must both be first-class runtime targets, with Codex/Kimi behavior preserved where already supported.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 MCP runtime launch planning, native generated-agent MCP projection, and MCPM/default registration are no longer implemented as ad hoc helpers in runner.ts/install-commands.ts/pipeline-init.ts.
- [x] #2 Default skill configuration references project-installed .agents/skills and pipe init shells out to npx skills add oisincoveney/skills.
- [x] #3 Codex and OpenCode launch paths expose only the profile-selected MCP surface as far as the host CLIs allow, with documented behavior for global config isolation.
- [x] #4 Existing stdio and remote MCP behavior remains covered by tests for Codex, OpenCode, Codex, and Kimi.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Completed MCP modularization, project-installed .agents/skills defaults, Codex/OpenCode scoped MCP projection, generated host-resource refresh, and MCP gateway/isolation docs. Verification: bun run check passed; bun run typecheck passed; bun run test passed with 279 tests passing and 15 live-runner tests skipped.

<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 Focused tests or documented research evidence cover the ticket acceptance criteria.
- [x] #2 Relevant project verification command is run and its result is recorded in the task final summary.
- [x] #3 Diff is reviewed for unrelated edits, unsafe casts/assertions, disabled checks, and shallow glue before marking done.
<!-- DOD:END -->
