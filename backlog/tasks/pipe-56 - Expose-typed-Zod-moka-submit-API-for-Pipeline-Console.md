---
id: PIPE-56
title: Expose typed Zod moka submit API for Pipeline Console
status: In Progress
assignee:
  - '@codex'
created_date: '2026-06-10 19:15'
updated_date: '2026-06-10 22:57'
labels: []
dependencies: []
ordinal: 178000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add a public Zod-backed submit API so Pipeline Console can spawn runs through package-owned moka submit semantics without shelling out or importing lower-level Argo, runner-command, or Kubernetes internals. The API should accept explicit repository, run, ticket/prompt task, delivery, event sink, and runner settings, then return the created run/workflow result.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A public package subpath exports Zod schemas, z.input/z.output-derived types, and a submit function for moka run submission.
- [ ] #2 The submit API supports prompt tasks and GitHub-backed ticket tasks with explicit repository URL, base branch, SHA, project/run identity, requester, and delivery settings.
- [ ] #3 The existing moka submit CLI adapts its flags into the same public schema-backed API instead of maintaining separate submit construction logic.
- [ ] #4 Tests cover full graph, quick graph, command mode, prompt task, ticket task, event sink settings, runner secret settings, and validation failures.
- [ ] #5 Pipeline Console can spawn runs through the public submit API without importing argo-submit, argo-workflow, runner-command-contract, or constructing Kubernetes/Argo resources directly.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implementation started as prerequisite for Pipeline Console PC-43. Scope: public moka-submit eventSink/direct hooks/hook policy API and external consumer evidence.

Package prerequisite implementation now has green release-gate evidence: bun run test, bun run typecheck, bun run check, and bun run build:cli all pass in /Users/oisin/dev/oisin-pipeline. Published npm @oisincoveney/pipeline@1.26.1 does not yet include eventSink/direct hooks/hookPolicy, so Pipeline Console must wait for a GitHub Actions release before production-real adoption.
<!-- SECTION:NOTES:END -->
