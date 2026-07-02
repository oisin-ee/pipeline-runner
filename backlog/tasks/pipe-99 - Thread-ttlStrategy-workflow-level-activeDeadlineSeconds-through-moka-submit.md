---
id: PIPE-99
title: Thread ttlStrategy + workflow-level activeDeadlineSeconds through moka submit
status: Done
assignee: []
created_date: '2026-07-02 14:30'
updated_date: '2026-07-02 17:48'
labels: []
dependencies: []
references:
  - src/moka-submit.ts
  - src/remote/argo/model.ts
  - src/remote/submit/argo-submission.ts
  - src/argo-submit.ts
  - 'https://argo-workflows.readthedocs.io/en/latest/fields/'
modified_files:
  - src/moka-submit.ts
  - src/remote/argo/model.ts
  - src/remote/submit/argo-submission.ts
  - src/argo-submit.ts
  - tests/moka-submit.test.ts
  - tests/argo-submit.test.ts
  - tests/package-public-api.test.ts
priority: high
ordinal: 336000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
What to build: Let callers set Workflow-level TTL, active deadline, and pod GC through the public moka submit path and have those fields appear in the created Argo Workflow manifest.
Scope: moka-submit option schemas, remote Argo submit option schemas, submitCompiledMokaWorkflow forwarding, argo-submit manifest builder inputs, public API tests, and submit-path golden coverage.
Dependencies / Blocked by: None - can start immediately.
Likely modified files: src/moka-submit.ts, src/remote/argo/model.ts, src/remote/submit/argo-submission.ts, src/argo-submit.ts, tests/moka-submit.test.ts, tests/argo-submit.test.ts, tests/package-public-api.test.ts.
Research required: Argo Workflow spec fields for ttlStrategy, activeDeadlineSeconds, and podGC; reuse existing Zod schema ownership in remote/argo/model.
Model recommendation:
- Claude: unknown -- no Claude model inventory evidenced in this Codex session.
- Codex: gpt-5.5-medium -- multi_agent_v1 metadata exposes gpt-5.5 with medium reasoning; choose medium because this is schema-forwarding work with existing manifest-builder precedent.
- OpenCode: moka-code-writer/default -- defaults/profiles.yaml defines moka-code-writer and defaults/pipeline.yaml routes implementation through broker/gpt-5.5 fallbacks; dispatch must revalidate live availability.
Implementation decisions:
- No defaults in this ticket. Caller-supplied fields only.
- Keep schema ownership in remote/argo/model and import/reuse where possible; do not duplicate a parallel Argo field schema.
- Add podGC support end-to-end if the manifest schema does not already include it.
Escalation:
- Met: every AC below with command output.
- Unmet: criterion id, failing command/output, and whether blocker is schema ownership, Argo field shape, or submit-path forwarding.
Origin: pipeline-console target-state spec (pipeline-console/backlog/docs/doc-8), 2026-07-02 audit.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 submitMoka accepts ttlStrategy, activeDeadlineSeconds, and podGC -- Evidence: moka-submit schema/unit test parses these fields through the public submit API.
- [x] #2 Static and dynamic created Workflow manifests carry caller-supplied ttlStrategy, activeDeadlineSeconds, and podGC -- Evidence: golden/assertion tests via submit path, not only raw buildRunnerArgoWorkflowManifest.
- [x] #3 Absence of those fields keeps current manifest output unchanged -- Evidence: existing golden tests stay green or focused regression asserts omitted fields.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 The feature-implementation workflow was run in order.
- [x] #2 `bun run test -- tests/moka-submit.test.ts tests/argo-submit.test.ts tests/package-public-api.test.ts` passed.
- [x] #3 `bun run typecheck` passed.
- [x] #4 `bun run check` passed.
- [x] #5 Semver-minor release note recorded in the repo's release-note mechanism, or blocker recorded if no release-note mechanism exists.
<!-- DOD:END -->
