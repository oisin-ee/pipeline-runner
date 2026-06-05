---
id: PIPE-49.10
title: Dogfood clean devspace runner-job path
status: To Do
assignee: []
created_date: '2026-06-05 12:27'
labels:
  - runner-job
  - dogfood
  - e2e
dependencies:
  - PIPE-49.4
  - PIPE-49.5
  - PIPE-49.6
  - PIPE-49.7
  - PIPE-49.8
  - PIPE-49.9
references:
  - package.json
  - docker/runner-entrypoint.sh
modified_files:
  - tests
parent_task_id: PIPE-49
priority: high
ordinal: 126000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Verify the self-contained runner-job path through real repository usage rather than isolated unit tests.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A real runner-job CLI invocation consumes OISIN_PIPELINE_RUNNER_PAYLOAD_JSON and event auth.
- [ ] #2 The dogfood uses a clean workspace/checkout path rather than dirty local repo state.
- [ ] #3 Evidence covers checkout, devspace gate, pipeline config load, MCP readiness, schedule generation when scheduled, and final workflow result.
- [ ] #4 If a full Kubernetes pod cannot be run locally, the result clearly states which real-usage layer was not verified.
- [ ] #5 Verification commands are recorded in the ticket final summary when implemented.
- [ ] #6 Dogfood evidence identifies whether PR delivery was exercised directly or deferred to PIPE-49.12.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add a dogfood/integration test or documented command path that exercises runner-job end-to-end with a clean checkout and real CLI behavior.
<!-- SECTION:PLAN:END -->
