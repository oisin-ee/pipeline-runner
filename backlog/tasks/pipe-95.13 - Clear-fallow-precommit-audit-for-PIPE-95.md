---
id: PIPE-95.13
title: Clear fallow precommit audit for PIPE-95
status: Done
assignee: []
created_date: '2026-07-05 19:19'
updated_date: '2026-07-06 04:27'
labels:
  - migration
dependencies:
  - PIPE-95.12
references:
  - >-
    backlog/tasks/pipe-95.12 -
    Clean-shared-test-fixtures-for-PIPE-95-strict-lint.md
  - package.json
modified_files:
  - src
  - tests
  - package.json
  - lock.yaml
parent_task_id: PIPE-95
priority: medium
ordinal: 358000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
What to build: Clear the pre-commit fallow audit findings exposed by the PIPE-95 staged diff without hiding dead code, duplication, stale suppressions, or unused dependencies.
Scope: Findings from the pre-commit `fallow-audit` output after PIPE-95.12. Do not add suppressions to silence fallow; remove dead exports/stale suppressions, consolidate real duplicate code behind existing boundaries, and remove unused dependencies only through the package manager.
Dependencies / Blocked by: PIPE-95.12.
Likely modified files: files named by fresh `fallow-audit`, especially source exports, stale fallow comments, duplicate helper groups, package.json and lock.yaml if unused dependency removal is required.
Research required: run fresh pre-commit or fallow audit first; inspect each finding for public API use before deletion; inspect package-manager help before dependency edits.
Model recommendation:

- Claude: unknown -- no Claude model inventory is exposed in this session.
- Codex: gpt-5.5-medium -- current host exposes gpt-5.5; dead-code/duplication cleanup needs judgement.
- OpenCode: moka-code-writer/default -- dispatch must revalidate live availability.
  Escalation:
- Met: fallow audit passes with no new suppressions.
- Unmet: record public API/duplication finding that needs a product/API decision.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Fallow audit is clean for the PIPE-95 diff. -- Evidence: the same pre-commit `fallow-audit` command that blocked the PIPE-95.4 commit exits 0.
- [x] #2 Dead code and duplication are addressed at source. -- Evidence: review names each removed stale suppression/dead export/duplicate group and its replacement or deletion.
- [x] #3 Package graph remains consistent. -- Evidence: if dependencies change, package-manager install/frozen lock proof passes; otherwise no package files changed.
- [x] #4 No shortcut suppressions are introduced. -- Evidence: added-line scan for `fallow-ignore|TODO: fix later|workaround|allow` is reviewed and any matches are pre-existing config vocabulary, not new bypasses.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Run the fallow gate, triage each finding as delete/consolidate/package cleanup/public API, apply smallest source changes, then rerun fallow plus typecheck/tests covering touched files.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Final evidence 2026-07-06: fallow gate clean. nubx fallow audit --fail-on-issues --format compact exit 0: dead code 0, duplication 0, no introduced complexity issues; 10 inherited complexity findings excluded by new-only gate. Source fixes removed dead exports, deleted src/config/schema/reference-validation.ts, centralized jscpd parsing in src/jscpd-output.ts, centralized Effect sync error helpers in src/effect-sync-errors.ts, and shared tool ignore patterns in tool-ignore-patterns.ts. oxlint suppressions were pruned with oxlint --prune-suppressions for the package check surface; no new suppressions added. Package graph verified by nub run check/typecheck/build/test.
<!-- SECTION:NOTES:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 The ticket global-rules feature-implementation workflow was run in order.
- [x] #2 Focused proof ran fresh and output was recorded.
- [x] #3 Required verify/review step passed, or blocker was reported in structured form.
<!-- DOD:END -->
