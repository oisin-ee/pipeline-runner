---
id: PIPE-42.1
title: Publish runner Job payload contract as a public package subpath
status: Done
assignee: []
created_date: '2026-06-04 08:20'
updated_date: '2026-06-04 08:40'
labels:
  - contract
  - runner
  - schema
dependencies: []
modified_files:
  - src/runner-job-contract.ts
  - package.json
  - tests/runner-job-contract.test.ts
  - tests/cli.test.ts
  - tests/package-public-api.test.ts
  - docs/pipeline-console-runner-contract.md
parent_task_id: PIPE-42
priority: high
ordinal: 101000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create the single executable source of truth for the Pipeline Console to runner Job payload in oisin-pipeline. This ticket owns the public contract surface only; runner behavior and console adoption are separate dependent tickets.

Architecture: keep JSON env-var payloads, use Zod as the TypeScript executable contract, and expose generated JSON Schema for neutral validation/docs. Do not introduce protobuf for this boundary.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 package.json exports ./runner-job-contract with ESM and types after build
- [x] #2 The exported contract includes RUNNER_JOB_CONTRACT_VERSION, runnerJobPayloadSchema, runnerJobPayloadJsonSchema, buildRunnerJobPayload, parseRunnerJobPayload, and structured validation error helpers
- [x] #3 The payload schema is strict at every object boundary and includes selector.workflowId plus selector.allowCommandHooks with boolean validation and default behavior documented
- [x] #4 Contract tests prove valid payload serialization, strict rejection of unknown fields, defaulting behavior, and JSON Schema generation
- [x] #5 Public API/export tests cover the new subpath so future packaging changes cannot silently drop it
<!-- AC:END -->



## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Update src/runner-job-contract.ts to expose the public builder/parser/schema/version API. Prefer existing Zod 4 and z.toJSONSchema; use existing AJV only if a JSON Schema validation test needs an independent validator. Update package.json exports, package/public API tests, runner-job contract tests, and docs/pipeline-console-runner-contract.md. No protobuf/codegen adoption in this slice.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Exported @oisincoveney/pipeline/runner-job-contract with RUNNER_JOB_CONTRACT_VERSION, builder/parser, validation issue details, and JSON Schema; package exports and build entries cover the public subpath.
<!-- SECTION:FINAL_SUMMARY:END -->
