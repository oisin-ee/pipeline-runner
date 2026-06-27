---
id: PIPE-45
title: 'Current structural cleanup: shrink god files and restore ownership boundaries'
status: To Do
assignee: []
created_date: '2026-06-04 14:40'
updated_date: '2026-06-27 14:09'
labels:
  - tech-debt
  - maintainability
  - decomposition
  - thermo-review
milestone: m-1
dependencies: []
references:
  - src/pipeline-runtime.ts
  - src/cli/program.ts
  - src/config/schemas.ts
  - src/runtime/agent-node/agent-node.ts
  - src/runtime/hooks/hooks.ts
  - src/moka-submit.ts
  - src/mcp/gateway.ts
  - src/argo-workflow.ts
  - src/install-commands.ts
  - src/runner.ts
  - package.json
priority: high
ordinal: 112000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Current source has regressed past the old PIPE-45 scope. The active cleanup target is the current production surface, not the stale src/config.ts/src/index.ts/schedule-planner wording. Oversized/current hotspots include src/pipeline-runtime.ts (1735), src/cli/program.ts (1338), src/config/schemas.ts (1111), src/runtime/agent-node/agent-node.ts (1075), plus near-threshold mixed-owner surfaces: src/runtime/hooks/hooks.ts, src/moka-submit.ts, src/mcp/gateway.ts, src/argo-workflow.ts, src/install-commands.ts, src/runner.ts, src/run-control/commands.ts, and src/run-control/store.ts.

Goal: reduce code size and cognitive load by moving each concern to one owner: config schemas/validation, workflow graph semantics, runner launch/subprocess execution, MCP host rendering, ticket commands, run-control command/store concerns, credentials/auth, CLI app services, runtime lifecycle/dependency/result handling, agent-node execution, hooks/gates policies, remote submit, Argo rendering, and install planning/writing.

Non-goals: no dependency-cruiser-style architecture tooling as the cleanup strategy; no hand-rolled replacements for maintained libs already present; no public package/API break without a guard and explicit ticket evidence.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Current public package exports, bin, CLI command surface, and config compatibility are guarded before structural edits -- Evidence: focused public API/dist contract tests pass.
- [ ] #2 All current oversized/mixed-owner modules are split by a single ownership boundary or have a recorded structural justification -- Evidence: line-count/fallow output after child tickets.
- [ ] #3 Library-first choices are preserved: Zod for schemas, Effect for runtime substrate, graphlib/graphology for graph domains, execa for subprocesses, official SDKs for OpenCode/Kubernetes, existing parsers for YAML/JSONC/globs -- Evidence: child tickets record reuse decisions and no replacement deps are added.
- [ ] #4 Auth/credentials and workflow graph semantics each have one owning module family instead of being mixed through unrelated CLI/runtime/MCP files -- Evidence: import graph/source inspection in relevant child tickets.
- [ ] #5 Dead surface is deleted only after public-contract and static-analysis evidence prove it is private/dead -- Evidence: knip/fallow/rg evidence recorded on deletion ticket.
- [ ] #6 Final cleanup passes typecheck, lint/check, focused tests, and review -- Evidence: command output and Code Rubric recorded on final ticket.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Progress (2026-06-27):
- AC#1 met by PIPE-45.1: public export map/bin guard added in tests/package-public-api.test.ts and focused public API/dist tests passed.
- DoD#1/DoD#2 met for graph creation: child tickets PIPE-45.1 through PIPE-45.18 created with workflow route, AC/DoD, refs/likely files, and dependency edges; backlog sequence list --plain run and inspected.
- Remaining parent AC#2-#6 stay open until structural, deletion, performance, and final-review tickets complete.
<!-- SECTION:NOTES:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Every child ticket carries one global-rules workflow route, concrete acceptance evidence, Definition of Done, likely files, and dependency edges.
- [x] #2 backlog sequence list --plain is run after graph creation and after dependency edits; sequence collisions are corrected.
- [ ] #3 Each completed code slice is verified with focused proof plus typecheck/check where relevant before commit.
<!-- DOD:END -->
