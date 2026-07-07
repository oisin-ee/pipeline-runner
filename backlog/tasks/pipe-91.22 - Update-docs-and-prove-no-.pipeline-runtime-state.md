---
id: PIPE-91.22
title: Update docs and prove no .pipeline runtime state
status: Done
assignee: []
created_date: "2026-06-28 09:05"
updated_date: "2026-07-07 09:47"
labels: []
dependencies:
  - PIPE-91.19
  - PIPE-91.20
  - PIPE-91.21
references:
  - README.md
  - docs/operator-guide.md
  - docs/moka-orchestrator-design.md
modified_files:
  - README.md
  - docs/operator-guide.md
  - docs/moka-orchestrator-design.md
  - tests/cli.test.ts
  - tests/moka-resume-schedule.test.ts
  - tests/next-node-submit-result-pg.test.ts
parent_task_id: PIPE-91
priority: medium
ordinal: 320000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: completion-claim
Scope: documentation and end-to-end proof that generated schedules, run-control state, stepping state, and resume state are Moka DB-owned and do not land in the working git repo.
Dependencies: PIPE-91.19, PIPE-91.20, PIPE-91.21
Likely modified files: README.md; docs/operator-guide.md; docs/moka-orchestrator-design.md; tests/cli.test.ts; tests/moka-resume-schedule.test.ts; tests/next-node-submit-result-pg.test.ts
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 README/operator docs describe DB-owned runtime state and do not instruct users to consume generated .pipeline/runs/<runId>/schedule.yaml for default runs -- Evidence: rg over README.md docs for .pipeline/runs shows only historical/migration notes or no hits
- [ ] #2 End-to-end test starts scheduled local run in a fresh git repo, steps/resumes via DB, and git status contains no .pipeline runtime paths -- Evidence: recorded test output and assertion over git status --porcelain
- [x] #3 PIPE-91 design doc reflects implemented reality and removes stale 'not yet built' wording if still present -- Evidence: docs diff + rg for 'not yet built' in docs/moka-orchestrator-design.md
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

Grooming verification 2026-07-04 (repo state, not a fresh gate run):

AC#1 MET — docs describe DB-owned runtime state; no default-run guidance to consume .pipeline/runs/<runId>/schedule.yaml. README.md: zero .pipeline/runs hits. docs/operator-guide.md is extensively DB-owned (lines 11, 96, 108, 356-368; lines 432-433 'default runtime state is DB-owned and does not create generated schedule or run-state artifacts'). Remaining .pipeline/runs refs in docs/run-control.md are the legitimate observability-output description, not default-run consumption guidance. Updated via a715d30 (PIPE-94.10) + 57782b9.

AC#3 MET — docs/moka-orchestrator-design.md reflects implemented reality: header (lines 3-5) states Layer B durable substrate + node-stepping 'are implemented'; Layer B phasing section lists 'Implemented: momokaya.db.url selects the DB substrate...moka resume rebuilds the graph'. No stale 'not yet built' wording (only 'Open risks (not yet designed)' heading at line 97, legitimate).

AC#2 NOT YET RECORDED — proof test EXISTS: tests/next-node-submit-result-pg.test.ts:317 asserts expect(gitStatusPorcelain(worktreePath)).toEqual([]) after next-node/submit-result in a fresh git worktree; tests/moka-resume-schedule.test.ts also captures gitStatusPorcelain. AC#2 evidence clause demands _recorded_ test output, and these are Postgres-gated (need db.url). Not run in this grooming pass.

REMAINING to close: run the completion-claim gate (typecheck, ultracite check, the pg-gated runtime-state tests) against a reachable DB and record output here, then check AC#2. Last open child of PIPE-91; deliverables (docs + proof test) are landed. Kept To Do pending that recorded run.

<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->

## created: 2026-07-07 09:47

## Migrated to ENG-37.1.

<!-- COMMENTS:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [ ] #1 Run the completion-claim workflow with fresh evidence
- [ ] #2 Run bun run typecheck, bun run check, focused runtime-state tests, and rg proof commands; record output
<!-- DOD:END -->
