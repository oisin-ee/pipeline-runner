---
id: PIPE-38.2
title: Add Kubernetes runner entrypoint for console Job payloads
status: Done
assignee: []
created_date: '2026-06-01 21:04'
updated_date: '2026-06-02 20:41'
labels:
  - pipeline
  - runner
  - cli
  - k8s
dependencies:
  - PIPE-38.1
references:
  - src/index.ts
  - src/pipeline-runtime.ts
  - README.md
  - >-
    /Users/oisin/dev/pipeline-console/server/src/services/pipeline/runner-job-client.service.ts
modified_files:
  - src/kubernetes-runner.ts
  - src/index.ts
  - package.json
  - tests/kubernetes-runner.test.ts
parent_task_id: PIPE-38
priority: high
ordinal: 59000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## What

Add a first-class CLI entrypoint that runs the existing pipeline runtime from the console-created Kubernetes Job payload.

## Command shape

Add a command that the image can use as its default command, for example:

```bash
oisin-pipeline runner-job
```

The command reads `OISIN_PIPELINE_RUNNER_PAYLOAD_JSON`, validates it through `src/runner-job-contract.ts`, resolves the target worktree, and calls the existing `runPipelineFromConfig` path. It must not shell out to the CLI just to re-enter the same package.

## Runtime invocation

Invoke `runPipelineFromConfig` with:

- `runId` from `payload.run.runId`
- `workflowId` from `payload.selector.workflowId`
- `task` from `payload.task.prompt`
- `worktreePath` from `PIPELINE_TARGET_PATH` when set, otherwise `process.cwd()`
- `signal` from an `AbortController` that PIPE-38.4 will wire to process signals
- `reporter` from the event sink implementation added by PIPE-38.3, or a no-op reporter until PIPE-38.3 lands

Exit code rules:

- `PASS` exits `0`
- `FAIL` exits `1`
- `CANCELLED` exits `130`
- payload/config validation failure exits `64`
- runtime startup error exits `70`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `oisin-pipeline runner-job` and the package `bin` entrypoint can execute a valid `OISIN_PIPELINE_RUNNER_PAYLOAD_JSON` without requiring `pipeline-console` code at runtime.
- [x] #2 The command passes `runId`, `workflowId`, `task`, `worktreePath`, and `reporter` into `runPipelineFromConfig` rather than re-planning a different workflow selection.
- [x] #3 The command uses `PIPELINE_TARGET_PATH` exactly like the existing CLI path does, so a Job can run from `/workspace/repo` or from a checked-out target mounted elsewhere.
- [x] #4 Tests cover valid payload execution, malformed JSON, missing payload, missing target config, runtime PASS, runtime FAIL, runtime CANCELLED, and the documented exit codes.
- [x] #5 The command does not create Kubernetes resources, query Kubernetes, write console database records, or assume it was spawned by the console rather than any compatible Job creator.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added the runner-job CLI entrypoint through src/kubernetes-runner.ts and src/index.ts. It validates OISIN_PIPELINE_RUNNER_PAYLOAD_JSON, resolves PIPELINE_TARGET_PATH, invokes runPipelineFromConfig with runId/workflowId/task/worktreePath/signal/reporter, and returns documented exit codes without importing or creating console/Kubernetes resources.
<!-- SECTION:FINAL_SUMMARY:END -->
