---
id: PIPE-95.13
title: Clear fallow precommit audit for PIPE-95
status: To Do
assignee: []
created_date: "2026-07-05 19:19"
updated_date: "2026-07-05 19:19"
labels:
  - migration
dependencies:
  - PIPE-95.12
references:
  - backlog/tasks/pipe-95.12 - Clean-shared-test-fixtures-for-PIPE-95-strict-lint.md
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

- [ ] #1 Fallow audit is clean for the PIPE-95 diff. -- Evidence: the same pre-commit `fallow-audit` command that blocked the PIPE-95.4 commit exits 0.
- [ ] #2 Dead code and duplication are addressed at source. -- Evidence: review names each removed stale suppression/dead export/duplicate group and its replacement or deletion.
- [ ] #3 Package graph remains consistent. -- Evidence: if dependencies change, package-manager install/frozen lock proof passes; otherwise no package files changed.
- [ ] #4 No shortcut suppressions are introduced. -- Evidence: added-line scan for `fallow-ignore|TODO: fix later|workaround|allow` is reviewed and any matches are pre-existing config vocabulary, not new bypasses.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Run the fallow gate, triage each finding as delete/consolidate/package cleanup/public API, apply smallest source changes, then rerun fallow plus typecheck/tests covering touched files.

<!-- SECTION:PLAN:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [ ] #1 The ticket global-rules feature-implementation workflow was run in order.
- [ ] #2 Focused proof ran fresh and output was recorded.
- [ ] #3 Required verify/review step passed, or blocker was reported in structured form.
<!-- DOD:END -->
