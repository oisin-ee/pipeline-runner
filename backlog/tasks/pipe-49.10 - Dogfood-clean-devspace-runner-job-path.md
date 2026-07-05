---
id: PIPE-49.10
title: Dogfood clean devspace runner-job path
status: To Do
assignee: []
created_date: "2026-06-05 12:27"
updated_date: "2026-07-04 19:43"
labels:
  - runner-job
  - dogfood
  - e2e
dependencies:
  - PIPE-49.7
  - PIPE-49.8
  - PIPE-49.9
references:
  - tests/dogfood-installed.test.ts
  - src/runner-command/run.ts
  - docs/pipeline-console-runner-contract.md
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

Groomed 2026-07-04 (verified against code, not ticket text). The ticket premise partly OBSOLETE and must be updated before implementing.

OBSOLETE: AC#1 says the runner-job consumes OISIN_PIPELINE_RUNNER_PAYLOAD_JSON. That env-var path was removed. Payload is now delivered via --payload-file (mounted ConfigMap) and event auth via events.authTokenFile; docs/pipeline-console-runner-contract.md ('Authentication') explicitly states 'No OISIN_PIPELINE_RUNNER_PAYLOAD_JSON, PIPELINE_EVENT_API_TOKEN, OPENCODE_AUTH_JSON ... is used.' The 'kubernetes-runner' surface named across this epic is also gone. Rewrite AC#1 to: 'a real runner-command CLI invocation consumes the --payload-file payload and events.authTokenFile.'

SUBSTANTIAL DOGFOOD ALREADY EXISTS: tests/dogfood-installed.test.ts (1039 lines) drives the INSTALLED package against a clean temp project -- installs config, compiles/validates/explains a generated .pipeline/runs/<id>/schedule.yaml through the CLI (line 447, 554), and exercises the goal loop. This covers a large part of AC#3 (pipeline config load, schedule generation, workflow result) on a clean-checkout path (AC#2).

REMAINING for a true e2e dogfood:

- AC#1 real runner-command CLI run consuming --payload-file (not the unit harness).
- AC#3 layers still unproven locally: real repo checkout into /workspace, devspace gate, MCP readiness, and PR delivery event.
- AC#4 must state which real-usage layer (full k8s pod) was not runnable locally.
- AC#5 record verification commands in the final summary.
- AC#6 note whether PR delivery was exercised here or deferred to PIPE-49.12 (PIPE-49.12 is now DONE -- PR delivery is a DAG builtin node; this dogfood should exercise it end-to-end or explicitly reference 49.12's tests).

Note: real published-package cluster dogfood is tracked as still-open in project memory (PIPE-94 tail). Kept To Do.

<!-- SECTION:NOTES:END -->
