---
id: PIPE-45.9
title: Extract CLI app services
status: To Do
assignee: []
created_date: '2026-06-27 14:03'
labels: []
dependencies:
  - PIPE-45.2
  - PIPE-45.5
  - PIPE-45.6
  - PIPE-45.7
references:
  - src/cli/program.ts
modified_files:
  - src/cli/program.ts
  - tests/cli.test.ts
parent_task_id: PIPE-45
priority: high
ordinal: 304000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: Shrink src/cli/program.ts by moving command app services to owned modules for run, MCP, init, doctor, and ticket flows while keeping Commander registration thin.
Dependencies: PIPE-45.2, PIPE-45.5, PIPE-45.6, PIPE-45.7
Likely modified files: src/cli/program.ts, src/app/run/*, src/app/mcp/*, src/app/init/*, tests/cli.test.ts
Reuse: commander stays CLI framework; existing command helpers stay preferred.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 src/cli/program.ts is thin command registration, not mixed runtime/MCP/init service logic -- Evidence: source inspection and line-count output.
- [ ] #2 CLI command behaviour remains stable -- Evidence: focused CLI tests pass.
- [ ] #3 No new command framework or parser is introduced -- Evidence: package.json/source diff.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order and record proof.
<!-- DOD:END -->
