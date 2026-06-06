---
id: PIPE-50.1
title: Fix release workflow tests after package-owned config defaults
status: Done
assignee: []
created_date: '2026-06-06 09:12'
updated_date: '2026-06-06 09:34'
labels:
  - ci
  - release
  - tests
dependencies: []
references:
  - .github/workflows/publish.yml
  - src/config.ts
modified_files:
  - tests/config.test.ts
  - tests/cli.test.ts
  - tests/dogfood-installed.test.ts
  - tests/install-commands.test.ts
  - tests/tracer-bullet.test.ts
  - tests/workflow-planner.test.ts
parent_task_id: PIPE-50
priority: high
ordinal: 130000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
GitHub Actions Release run 27057745167 for commit 4fe9b7dd16c9961e493d2e3a7da39925bf647917 failed in the npm release job at bun run test. The failures are stale tests around loadPipelineConfig/package-owned defaults, CLI entrypoint behavior, install-command projections, and missing-file validation expectations. The image publish job succeeded, but package release remains blocked.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 bun run test passes locally with the current package-owned config behavior.
- [x] #2 Tests that intentionally exercise custom/repo-local config use parsePipelineConfigParts or another explicit custom-config seam instead of loadPipelineConfig.
- [x] #3 GitHub Actions Release no longer fails in the Test step for these stale expectations.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Update stale tests to match the package-owned config contract without restoring repo-local .pipeline loading. Verify with bun run test and, if possible, a fresh pushed Release workflow run.
<!-- SECTION:PLAN:END -->
