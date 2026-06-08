---
id: PIPE-51.7
title: Update defaults and docs for repo-aware gateway
status: To Do
assignee: []
created_date: '2026-06-08 15:54'
labels:
  - mcp
  - gateway
  - docs
dependencies:
  - PIPE-51.1
  - PIPE-51.2
  - PIPE-51.3
  - PIPE-51.4
  - PIPE-51.5
  - PIPE-51.6
references:
  - src/pipeline-init.ts
  - docs/mcp-gateway.md
  - docs/operator-guide.md
  - tests/pipeline-init.test.ts
modified_files:
  - src/pipeline-init.ts
  - docs/mcp-gateway.md
  - docs/operator-guide.md
  - tests/pipeline-init.test.ts
parent_task_id: PIPE-51
priority: medium
ordinal: 143000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Update generated defaults, AGENTS guidance, and operator docs so projects know how to declare repo-aware upstreams while agents still request only pipeline-gateway.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 pipe init defaults include the gateway backend contract without direct upstream MCP profile grants.
- [ ] #2 Docs state repo-aware MCPs bind to current workspace/PIPELINE_TARGET_PATH and must not clone or mirror repositories.
- [ ] #3 Docs show local dev and runner-job flows, including reconcile, configure-host, doctor, and expected verification commands.
- [ ] #4 Tests covering generated defaults and installed dogfood snapshots are updated.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Update src/pipeline-init.ts, docs/mcp-gateway.md, docs/operator-guide.md, and generated command/install expectations. Keep examples small and concrete.
<!-- SECTION:PLAN:END -->
