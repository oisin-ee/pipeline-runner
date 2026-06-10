---
id: PIPE-56.5
title: Prove Pipeline Console uses the cleaned Moka submit API
status: To Do
assignee: []
created_date: '2026-06-10 22:13'
labels:
  - api
  - console
  - verification
dependencies:
  - PIPE-56.1
  - PIPE-56.3
  - PIPE-56.4
references:
  - >-
    /Users/oisin/dev/pipeline-console/server/src/services/pipeline/runner-job-client.service.ts
  - >-
    /Users/oisin/dev/pipeline-console/server/src/services/pipeline/runner-job-client.service.test.ts
modified_files:
  - tests/package-public-api.test.ts
  - README.md
  - docs/operator-guide.md
parent_task_id: PIPE-56
priority: high
ordinal: 183000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Verify the cleaned public Moka submit API from an external consumer and through Pipeline Console's runner submission path. This ticket owns adoption evidence and docs after the package API shape is implemented.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The package public API test compiles a separate TypeScript consumer that submits with eventSink and a direct node.finish hook without importing Argo, runner-command internals, or raw hook registry config.
- [ ] #2 Pipeline Console runner-job-client uses eventSink in its MokaSubmitInput construction and does not construct raw hooks.functions or hooks.on[event] arrays for run-specific hooks.
- [ ] #3 Pipeline Console tests cover the submitted Moka input shape, including eventSink and any real run-specific hooks or explicit absence of hooks.
- [ ] #4 Docs distinguish eventSink as runner event transport from hooks as runner-side lifecycle behavior, using TypeScript examples only for the API section.
- [ ] #5 Real verification commands are recorded for package tests/typecheck/build and Pipeline Console server tests/typecheck, or any unrun command is explicitly called out with the blocker.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
After PIPE-56.1 through PIPE-56.4 land, update tests/package-public-api.test.ts and README docs in this repo. Then update ~/dev/pipeline-console server submit construction and tests against the published/local package API. Do not verify with synthetic-only scripts; use the actual package build and console server test paths.
<!-- SECTION:PLAN:END -->
