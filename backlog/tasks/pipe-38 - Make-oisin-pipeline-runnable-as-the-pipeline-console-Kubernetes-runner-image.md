---
id: PIPE-38
title: Make oisin-pipeline runnable as the pipeline-console Kubernetes runner image
status: Done
assignee: []
created_date: "2026-06-01 21:03"
updated_date: "2026-06-02 20:41"
labels:
  - pipeline
  - runner
  - k8s
  - console-integration
dependencies: []
references:
  - src/index.ts
  - src/pipeline-runtime.ts
  - src/runner.ts
  - README.md
  - >-
    /Users/oisin/dev/pipeline-console/server/src/services/pipeline/runner-job-client.service.ts
  - >-
    /Users/oisin/dev/pipeline-console/server/src/services/pipeline/runner-run-control.service.ts
  - /Users/oisin/dev/pipeline-console/contracts/src/pipeline/run.ts
modified_files:
  - src/
  - tests/
  - Dockerfile
  - .dockerignore
  - .github/workflows/
  - README.md
  - docs/
priority: high
ordinal: 57000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

## What

Turn the existing TypeScript/Bun `@oisincoveney/pipeline` package into the image and entrypoint that `pipeline-console` launches as a plain Kubernetes `batch/v1` Job.

`pipeline-console` already owns Job creation, Kubernetes/Kueue discovery, run listing, cancellation, event storage, and UI rendering. `oisin-pipeline` owns the runner image, payload parsing, invocation of the existing runtime, event translation, authenticated event posting, cancellation handling inside the running process, and documentation for the contract.

## Existing code this must fit

- `src/index.ts` exposes the CLI and already supports `run`, `pipe`, configured entrypoint subcommands, `validate`, `explain-plan`, and `doctor`.
- `src/pipeline-runtime.ts` exports `runPipelineFromConfig` and emits structured `PipelineRuntimeEvent` values through `reporter`.
- `PipelineRuntimeOptions` already accepts `runId`, `workflowId`, `entrypoint`, `task`, `worktreePath`, `signal`, and `reporter`.
- `README.md` documents `PIPELINE_TARGET_PATH` for invoking the pipeline from outside the target worktree.
- Completed `pipeline-console` runner code creates Jobs with one env var, `OISIN_PIPELINE_RUNNER_PAYLOAD_JSON`, labels them with `pipeline.oisin.dev/*`, and accepts authenticated `POST /runs/:runId/events` event batches.

## Non-goals

- Do not add a separate Kubernetes API type, reconciliation manager, event database, event server, or language stack to this repository.
- Do not make each pipeline instance deploy its own console, database, or Kubernetes API surface.
- Do not import `pipeline-console` server code into the runner image.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 The child tickets define a runner-image implementation plan around the current TypeScript runtime and completed `pipeline-console` Job/event contract.
- [x] #2 The runner can execute a console-created payload by invoking the existing `runPipelineFromConfig` path with `runId`, `workflowId`, `task`, `worktreePath`, `signal`, and a runtime reporter.
- [x] #3 Runner events are posted to the console event sink as ordered authenticated batches whose shape matches `pipeline-console`'s completed `appendRunEvents` path.
- [x] #4 Kubernetes Job termination maps to `AbortSignal`, final event flushing, and a deterministic process exit code.
- [x] #5 Image publishing and docs are scoped to this package and its runner contract; console-owned Job creation, event storage, UI, database, and Kubernetes discovery remain outside this repo.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Epic-drain implementation route approved by `$epic PIPE-38` on 2026-06-02.

Research findings: runtime already supports runId/workflowId/task/worktreePath/signal/reporter; console creates one OISIN_PIPELINE_RUNNER_PAYLOAD_JSON payload and accepts authenticated ordered event batches; no Kubernetes API/event DB/console code belongs in this repo.

Track routing:

- backend: PIPE-38.1, PIPE-38.2, PIPE-38.3, PIPE-38.4, PIPE-38.6
- k8s: PIPE-38.5
- test: empty
- frontend: empty

Execution plan:

1. Run backend and k8s implementation in isolated worktrees under .pipeline/runs/pipe-38/.
2. Backend track owns contract, runner-job entrypoint, event sink, cancellation behavior, and integration docs.
3. K8s track owns Dockerfile/.dockerignore/image smoke test/publish workflow image changes.
4. Merge tracks back, resolve conflicts, then run configured review-verdict gate via thermo-nuclear review.
5. Keep console-owned Job creation, event storage, UI, database, Kubernetes discovery, and cancellation API outside this repo.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Completed PIPE-38 via backend commit 9e37560, k8s commit 9068308, merge commits a33c5d0/d639f98, and review-fix commit 1eb988c. The package now provides the runner-job command, console payload/event contract, authenticated event sink, cancellation handling, runner image/publish workflow, and docs while leaving console-owned Job creation, event storage, UI, database, and Kubernetes discovery outside this repo. Verification in a clean PIPE-38 worktree passed targeted runner/image tests, bun run check, bun run typecheck, bun run build, full bun run test, bun run test:image, and the final thermo-nuclear review gate.

<!-- SECTION:FINAL_SUMMARY:END -->
