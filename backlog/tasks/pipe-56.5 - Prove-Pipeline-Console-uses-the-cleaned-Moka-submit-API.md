---
id: PIPE-56.5
title: Prove Pipeline Console uses the cleaned Moka submit API
status: Done
assignee:
  - '@codex'
created_date: '2026-06-10 22:13'
updated_date: '2026-06-11 00:21'
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
- [x] #1 The package public API test compiles a separate TypeScript consumer that submits with eventSink and a direct node.finish hook without importing Argo, runner-command internals, or raw hook registry config.
- [x] #2 Pipeline Console runner-job-client uses eventSink in its MokaSubmitInput construction and does not construct raw hooks.functions or hooks.on[event] arrays for run-specific hooks.
- [x] #3 Pipeline Console tests cover the submitted Moka input shape, including eventSink and any real run-specific hooks or explicit absence of hooks.
- [x] #4 Docs distinguish eventSink as runner event transport from hooks as runner-side lifecycle behavior, using TypeScript examples only for the API section.
- [x] #5 Real verification commands are recorded for package tests/typecheck/build and Pipeline Console server tests/typecheck, or any unrun command is explicitly called out with the blocker.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
After PIPE-56.1 through PIPE-56.4 land, update tests/package-public-api.test.ts and README docs in this repo. Then update ~/dev/pipeline-console server submit construction and tests against the published/local package API. Do not verify with synthetic-only scripts; use the actual package build and console server test paths.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Published @oisincoveney/pipeline 1.27.0 through GitHub Actions Release run 27314874423 (success) from e28d6f42e5ae4a0816f39bf9944b26243631911f. npm latest now resolves to 1.27.0.

Verified published tarball exposes eventSink, mokaSubmitDirectHooksSchema, mokaSubmitHookPolicySchema, runner hookPolicy, and runner-command consumption in dist output; no local file/link package used.

Pipeline Console now depends on @oisincoveney/pipeline 1.27.0 in root and server manifests, constructs MokaSubmitInput with eventSink and hookPolicy, and validates via the public mokaSubmitOptionsSchema.

Verification: package Release workflow passed test/typecheck/check/build/release/image publish; local package full bun run test/typecheck/check/build passed before release; Console server focused runner-job-client and pipeline-command-config tests passed; Console server typecheck passed; Ultracite passed on touched Console files.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Proved the cleaned Moka submit API through the published package and Pipeline Console adoption.

Changes:
- Published @oisincoveney/pipeline 1.27.0 via GitHub Actions Release run 27314874423.
- Verified the published tarball exposes eventSink, direct hook schemas, hook policy types, and runner hookPolicy wiring.
- Updated Pipeline Console to consume 1.27.0, construct eventSink instead of legacy events, and pass explicit hookPolicy for allowCommandHooks.
- Kept Console launch on the public moka-submit schema surface without importing Argo or runner-command internals.

Tests:
- GitHub Actions Release run 27314874423 passed test, typecheck, check, build, release, and runner image publish.
- npm view @oisincoveney/pipeline@1.27.0 confirmed latest 1.27.0.
- Published tarball inspection confirmed eventSink and hook policy exports.
- Console: pnpm --filter @pipeline-console/server exec node --import tsx --test src/services/pipeline/runner-job-client.service.test.ts src/services/pipeline/pipeline-command-config.test.ts.
- Console: pnpm --filter @pipeline-console/server typecheck.
- Console: pnpm exec ultracite check on touched package/runner files.
<!-- SECTION:FINAL_SUMMARY:END -->
