---
id: PIPE-56
title: Expose typed Zod moka submit API for Pipeline Console
status: Done
assignee:
  - '@codex'
created_date: '2026-06-10 19:15'
updated_date: '2026-06-11 00:22'
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
- [x] #1 A public package subpath exports Zod schemas, z.input/z.output-derived types, and a submit function for moka run submission.
- [x] #2 The submit API supports prompt tasks and GitHub-backed ticket tasks with explicit repository URL, base branch, SHA, project/run identity, requester, and delivery settings.
- [x] #3 The existing moka submit CLI adapts its flags into the same public schema-backed API instead of maintaining separate submit construction logic.
- [x] #4 Tests cover full graph, quick graph, command mode, prompt task, ticket task, event sink settings, runner secret settings, and validation failures.
- [x] #5 Pipeline Console can spawn runs through the public submit API without importing argo-submit, argo-workflow, runner-command-contract, or constructing Kubernetes/Argo resources directly.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implementation started as prerequisite for Pipeline Console PC-43. Scope: public moka-submit eventSink/direct hooks/hook policy API and external consumer evidence.

Package prerequisite implementation now has green release-gate evidence: bun run test, bun run typecheck, bun run check, and bun run build:cli all pass in /Users/oisin/dev/oisin-pipeline. Published npm @oisincoveney/pipeline@1.26.1 does not yet include eventSink/direct hooks/hookPolicy, so Pipeline Console must wait for a GitHub Actions release before production-real adoption.

All PIPE-56 subtasks are complete. Published @oisincoveney/pipeline 1.27.0 via GitHub Actions Release run 27314874423, verified npm latest, inspected published tarball for eventSink/direct hooks/hookPolicy, and adopted the package in Pipeline Console PC-43.1 without local links or internal Argo/runner imports.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Exposed and proved the public Zod-backed Moka submit API for Pipeline Console.

Changes:
- Added the public moka-submit API shape with eventSink terminology, prompt/ticket task support, run/repository identity, runner secret/image settings, direct hook inputs, and explicit hookPolicy.
- Normalized direct submit hooks into runtime hook config internally while keeping Console off raw hooks.functions/hooks.on wiring.
- Wired runner payloads to carry hookPolicy and runner-command execution to honor it.
- Published @oisincoveney/pipeline 1.27.0 through GitHub Actions and adopted it in Pipeline Console PC-43.1.

Verification:
- GitHub Actions Release run 27314874423 passed test, typecheck, check, build, release, and runner image publish.
- npm view @oisincoveney/pipeline@1.27.0 confirmed latest 1.27.0.
- Published tarball inspection confirmed eventSink/direct hook/hookPolicy exports and runner-command consumption.
- Console focused server tests/typecheck/Ultracite passed for the adoption path.
<!-- SECTION:FINAL_SUMMARY:END -->
