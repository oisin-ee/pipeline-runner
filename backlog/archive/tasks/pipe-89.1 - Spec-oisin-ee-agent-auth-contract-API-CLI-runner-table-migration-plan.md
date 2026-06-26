---
id: PIPE-89.1
title: 'Spec @oisin-ee/agent-auth contract: API, CLI, runner table, migration plan'
status: To Do
assignee: []
created_date: '2026-06-22 20:29'
labels: []
dependencies: []
references:
  - src/codex-auth-sync.ts
  - src/argo-workflow.ts
modified_files:
  - docs/agent-auth-library-spec.md
parent_task_id: PIPE-89
priority: high
ordinal: 254000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: plan-scope-spec
Scope: design doc only, no package code. Define: (1) package home (sub-package of oisin-pipeline vs new repo) — decide with rationale; (2) TS API surface (materialize(runner, source, opts), check/dry-run, result shape) generalised from src/codex-auth-sync.ts; (3) CLI surface (agent-auth materialize --runner <codex|opencode|claude|pi> ...) for shell/Docker/Nix/Terraform consumers; (4) the runner table (data) keyed by runner -> {auth/accounts file paths, plugin/config wiring, env}; (5) account-source contract (mounted accounts.json from ESO/OpenBao) — what stays in OpenBao/ESO unchanged; (6) per-consumer migration plan (moka, autofix worker, pipeline-runner image, coder dev-workspace).
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Spec doc committed under docs/ -- Evidence: file path + git show
- [ ] #2 Runner table enumerates codex, opencode, claude, pi with file paths + wiring sourced from existing code -- Evidence: doc cites src/codex-auth-sync.ts, infra coder main.tf, pipeline-runner image, autofix agent-credentials.ts
- [ ] #3 Package-home decision recorded with rationale -- Evidence: doc section 'Package home'
- [ ] #4 Per-consumer migration steps listed, each mapped to a child ticket -- Evidence: doc table consumer->ticket
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run plan-scope-spec workflow in order (inspect facts, list assumptions, define AC, grill/doubt review)
- [ ] #2 grill/doubt review recorded; no code edits
<!-- DOD:END -->
