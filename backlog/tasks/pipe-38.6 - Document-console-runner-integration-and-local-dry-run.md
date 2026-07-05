---
id: PIPE-38.6
title: Document console runner integration and local dry run
status: Done
assignee: []
created_date: "2026-06-02 19:20"
updated_date: "2026-06-02 20:41"
labels:
  - pipeline
  - runner
  - docs
  - console-integration
dependencies:
  - PIPE-38.5
references:
  - README.md
  - docs/operator-guide.md
  - docs/pipeline-console-runner-contract.md
  - /Users/oisin/dev/pipeline-console/chart/values.yaml
  - /Users/oisin/dev/pipeline-console/chart/templates/runner-configmap.yaml
modified_files:
  - README.md
  - docs/operator-guide.md
  - docs/pipeline-console-runner-contract.md
parent_task_id: PIPE-38
priority: high
ordinal: 63000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

## What

Document the completed integration boundary so future implementers and operators keep `oisin-pipeline` scoped to the runner package/image instead of adding a second Kubernetes-facing service layer inside this repository.

## Content to include

- The console-created Kubernetes Job payload and labels.
- The runner image value expected by `pipeline-console`: `pipeline.runner.image`.
- The console runner config fields: queue name, service account, resource requests/limits, active deadline, TTL, backoff limit, event sink URL, and auth header.
- The required runner-side token source and how it must match the console API's `PIPELINE_EVENT_API_TOKEN`.
- A local dry run using `OISIN_PIPELINE_RUNNER_PAYLOAD_JSON`, `PIPELINE_TARGET_PATH`, and a mock/fake event sink.
- A Kubernetes dry run showing the env payload, runner image, queue label, and service account shape.
- Troubleshooting for missing payload, invalid auth, missing target `.pipeline/pipeline.yaml`, missing external agent CLI, event sink 401/403, and cancellation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 README explains that `oisin-pipeline` is the runner package/image and `pipeline-console` is the surface that creates/lists/cancels Jobs and stores events.
- [x] #2 `docs/pipeline-console-runner-contract.md` includes the exact current `OISIN_PIPELINE_RUNNER_PAYLOAD_JSON` example from completed console code and the exact event batch shape accepted by console.
- [x] #3 `docs/operator-guide.md` includes a local dry-run command and a Kubernetes Job dry-run example that do not require creating any new Kubernetes API kind.
- [x] #4 Docs explicitly state that the runner does not own the console database, event store, Job builder, Kueue watcher, or UI.
- [x] #5 Documentation review verifies there are no instructions to add a new language stack, add a separate Kubernetes API type, deploy a console per run, or create a database per run.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Updated README, docs/operator-guide.md, and docs/pipeline-console-runner-contract.md with the console/runner boundary, payload and event batch shape, token sources, local dry run, Kubernetes Job dry-run, image verification, and troubleshooting without adding any new Kubernetes API/service/database responsibilities.

<!-- SECTION:FINAL_SUMMARY:END -->
