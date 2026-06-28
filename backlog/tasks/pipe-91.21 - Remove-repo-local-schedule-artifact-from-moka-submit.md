---
id: PIPE-91.21
title: Remove repo-local schedule artifact from moka submit
status: Done
assignee: []
created_date: '2026-06-28 09:05'
updated_date: '2026-06-28 09:49'
labels: []
dependencies:
  - PIPE-91.17
references:
  - src/remote/submit/compilation.ts
  - src/argo-submit.ts
  - src/remote/argo/storage.ts
modified_files:
  - src/remote/submit/compilation.ts
  - src/moka-submit.ts
  - src/argo-submit.ts
  - tests/moka-submit.test.ts
  - tests/argo-submit.test.ts
parent_task_id: PIPE-91
priority: high
ordinal: 319000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: migrate moka submit graph compilation from generate-to-.pipeline/runs-then-read to in-memory schedule YAML; keep Kubernetes ConfigMap mount inside Argo pods because that is not working-repo state.
Dependencies: PIPE-91.17
Likely modified files: src/remote/submit/compilation.ts; src/moka-submit.ts; src/argo-submit.ts; tests/moka-submit.test.ts; tests/argo-submit.test.ts
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 moka submit quick/full generates schedule YAML in memory and does not create .pipeline/runs in the target worktree -- Evidence: focused submit compilation test uses temp git repo and asserts no .pipeline path after compile/submit plan
- [x] #2 Explicit --schedule path remains an explicit user-provided input only; generated default path no longer creates repo-local artifacts -- Evidence: tests cover explicit schedule input separately from generated schedule input
- [x] #3 Argo submission still stores schedule YAML in Kubernetes ConfigMap and runner pods still receive /etc/pipeline/schedule.yaml -- Evidence: argo-submit/template tests assert ConfigMap data schedule.yaml and mount path unchanged
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Covered moka submit generated schedules as in-memory-only and confirmed explicit schedule paths plus Argo ConfigMap handoff remain intact. Production path already switched to generateScheduleArtifactInMemory in PIPE-91.17; this ticket adds direct regression coverage.

Evidence:
- bun test tests/moka-submit.test.ts tests/argo-submit.test.ts => 26 pass, 0 fail, 81 expect() calls
- bun run typecheck => tsc --noEmit exit 0
- bun run check => ultracite checked 469 files, no fixes
- git diff --check => clean
- rg audit: generated submit path returns schedule.yaml from memory; explicit schedulePath uses readScheduleFile; Argo ConfigMap data/mount still use schedule.yaml and /etc/pipeline/schedule.yaml.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Run the ticket's global-rules workflow in order
- [x] #2 Run bun test tests/moka-submit.test.ts tests/argo-submit.test.ts and bun run typecheck; record output
<!-- DOD:END -->
