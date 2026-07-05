---
id: PIPE-42.4
title: Guard runner image and console dependency contract version skew
status: Done
assignee: []
created_date: "2026-06-04 08:21"
updated_date: "2026-06-04 08:40"
labels:
  - contract
  - ci
  - release
  - momokaya
dependencies:
  - PIPE-42.2
  - PIPE-42.3
references:
  - >-
    /Users/oisin/dev/pipeline-console/server/src/services/pipeline/runner-job-config.service.ts
  - >-
    /Users/oisin/dev/pipeline-console/server/src/services/pipeline/runner-job-config.service.test.ts
  - >-
    /Users/oisin/dev/pipeline-console/server/src/services/pipeline/runner-job-client.service.test.ts
  - /Users/oisin/dev/pipeline-console/README.md
modified_files:
  - tests/runner-image.test.ts
  - package.json
  - docs/operator-guide.md
  - docs/pipeline-console-runner-contract.md
parent_task_id: PIPE-42
priority: high
ordinal: 104000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Add deployment and CI checks that make runner/console contract skew visible before Momokaya creates a failing Job. This ticket owns cross-repo verification and release metadata; it depends on both runner behavior and console adoption.

The goal is not just to fix allowCommandHooks once. The goal is to make future payload drift a build/test failure or a pre-Job structured rejection.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Runner payload includes a contractVersion or equivalent version marker, and runner validation rejects incompatible major versions with a structured validation failure
- [x] #2 Runner image build/publish metadata exposes the runner contract version or package version used by the image
- [x] #3 Pipeline Console configuration or startup validation records the expected runner contract version for the configured runner image/package
- [x] #4 CI or repository tests exercise representative console-built payloads through the actual imported runner parser and fail on schema drift
- [x] #5 Docs explain the source of truth, release order, version skew behavior, and real verification commands for oisin-pipeline image smoke tests plus pipeline-console runner Job tests
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Update oisin-pipeline image/package tests and docs, plus pipeline-console config/tests as needed. Prefer existing package scripts: bun run build, bun run test:image in oisin-pipeline; pnpm --filter @pipeline-console/server test/typecheck in pipeline-console. Do not add protobuf. Do not rely on docs-only checks; the guard must execute the contract parser against console-built payloads.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Runner payloads include contractVersion 1 and reject incompatible versions with structured validation. Dockerfile image labels expose package and contract versions. pipeline-console config defaults runner.expectedContractVersion from the shared contract and stamps Jobs with pipeline.oisin.dev/runner-contract-version. Console tests exercise representative built payloads through the imported runner parser. Docker smoke was not run successfully because the local Docker/OrbStack socket was unavailable.

<!-- SECTION:FINAL_SUMMARY:END -->
