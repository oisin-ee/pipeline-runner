---
id: PIPE-42
title: Accept or reject console selector fields before runner jobs fail
status: Done
assignee: []
created_date: '2026-06-03 22:22'
updated_date: '2026-06-04 08:40'
labels:
  - bug
  - runner
  - schema
  - momokaya
dependencies: []
priority: high
ordinal: 100000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Momokaya runner job pipeline-run-pipeline-console-fxs8b for run e6f390b2-43f4-4a6c-a2c2-c2e79272f6b8 failed twice and hit BackoffLimitExceeded. Pod logs show 'selector: Unrecognized key: allowCommandHooks' and the runner container exits 64. Pipeline Console dispatched selector.allowCommandHooks=false along with workflowId=inspect, so the runner/API schema contract is inconsistent. The system should either accept this selector field or reject the run before scheduling a Kubernetes job. Evidence: /tmp/pipeline-console-audit-20260604-011117/runner.failed.logs.txt, runner.failed.job.describe.txt, runner.failed.pod.describe.txt, run-detail.failed.snapshot.txt
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The pipeline runner and console dispatch contract agree on selector.allowCommandHooks, including validation type and default behavior.
- [x] #2 Invalid selector fields are rejected before creating a Kubernetes Job, with a structured error that Pipeline Console can render.
- [x] #3 Valid inspect workflow runs no longer fail with 'Unrecognized key: allowCommandHooks'.
- [x] #4 Runner events include schema validation failures and terminal failure summaries for downstream UI observability.
- [x] #5 Tests cover selector payload compatibility between dispatch API, job payload construction, and runner parsing.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Scoped on 2026-06-04: use oisin-pipeline as the source of truth for the runner Job payload contract. Do not introduce protobuf for this boundary yet; keep JSON env-var payloads, publish a public @oisincoveney/pipeline/runner-job-contract subpath, expose executable builder/parser/schema/version APIs plus generated JSON Schema, and make pipeline-console import/validate against that contract before createNamespacedJob. Dependency shape: PIPE-42.1 establishes the contract; PIPE-42.2 runner behavior and PIPE-42.3 console adoption can run after it in parallel; PIPE-42.4 adds contract-version skew guards and release/CI verification after both integrations.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented shared runner Job payload contract in oisin-pipeline and adopted it in pipeline-console. Runner now accepts selector.allowCommandHooks, passes it into hook policy, rejects schema drift before runtime, and emits runner.schema.validation plus workflow.finish for recoverable invalid payloads. Console now builds payloads with @oisincoveney/pipeline/runner-job-contract, rejects invalid payloads before createNamespacedJob, records runner.expectedContractVersion, and labels Jobs with the expected contract version. Verification passed: bun run typecheck, bun run check, bun run test, bun run build, built CLI runner-job success smoke with contractVersion 1 and allowCommandHooks false, built CLI recoverable schema-validation smoke, targeted pipeline-console runner-job-client/config tests, and pipeline-console server typecheck against a temporary local package symlink. bun run test:image did not run because Docker/OrbStack socket was unavailable.
<!-- SECTION:FINAL_SUMMARY:END -->
