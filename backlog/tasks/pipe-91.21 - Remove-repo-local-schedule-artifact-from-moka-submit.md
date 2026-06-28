---
id: PIPE-91.21
title: Remove repo-local schedule artifact from moka submit
status: To Do
assignee: []
created_date: '2026-06-28 09:05'
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
- [ ] #1 moka submit quick/full generates schedule YAML in memory and does not create .pipeline/runs in the target worktree -- Evidence: focused submit compilation test uses temp git repo and asserts no .pipeline path after compile/submit plan
- [ ] #2 Explicit --schedule path remains an explicit user-provided input only; generated default path no longer creates repo-local artifacts -- Evidence: tests cover explicit schedule input separately from generated schedule input
- [ ] #3 Argo submission still stores schedule YAML in Kubernetes ConfigMap and runner pods still receive /etc/pipeline/schedule.yaml -- Evidence: argo-submit/template tests assert ConfigMap data schedule.yaml and mount path unchanged
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the ticket's global-rules workflow in order
- [ ] #2 Run bun test tests/moka-submit.test.ts tests/argo-submit.test.ts and bun run typecheck; record output
<!-- DOD:END -->
