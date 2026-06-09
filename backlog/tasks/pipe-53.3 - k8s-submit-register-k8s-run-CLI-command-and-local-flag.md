---
id: PIPE-53.3
title: 'k8s-submit: register k8s-run CLI command and --local flag'
status: To Do
assignee: []
created_date: '2026-06-09 19:53'
labels:
  - cli
dependencies:
  - PIPE-53.1
references:
  - src/index.ts
  - src/k8s-submit.ts
modified_files:
  - src/index.ts
parent_task_id: PIPE-53
priority: high
ordinal: 161000
---

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 oisin-pipeline k8s-run --entrypoint quick --event-url http://localhost:3000/api/events 'fix login' attempts k8s Job creation
- [ ] #2 oisin-pipeline k8s-run --help shows all flags with descriptions
- [ ] #3 Missing required --entrypoint or --event-url prints error and exits non-zero
- [ ] #4 oisin-pipeline run --local --entrypoint quick 'task' succeeds (same as current behavior)
- [ ] #5 oisin-pipeline run --entrypoint quick 'task' still works (no regression)
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Changes to src/index.ts (~60 lines):

1. Import submitK8sRunnerJob and k8sSubmitOptionsSchema from ./k8s-submit
2. Register k8s-run subcommand with commander:
   - Required: --entrypoint <quick|execute>, --event-url <url>
   - Optional: --namespace <ns> (default pipeline-runs), --orchestrator <codex|opencode> (default opencode), --kubeconfig <path>
   - Positional: <description...>
3. Action: validate args with k8sSubmitOptionsSchema.parse(), call submitK8sRunnerJob(), print 'Job submitted: <jobName> in namespace <namespace>.'
4. Add --local option to existing run command (no-op flag, documentation signal)
5. Error handling: Zod validation errors -> print issues, exit 64. K8s API errors -> print message, exit 1.
<!-- SECTION:PLAN:END -->
