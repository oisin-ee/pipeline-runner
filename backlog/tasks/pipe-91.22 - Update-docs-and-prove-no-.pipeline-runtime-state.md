---
id: PIPE-91.22
title: Update docs and prove no .pipeline runtime state
status: To Do
assignee: []
created_date: '2026-06-28 09:05'
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
- [ ] #1 README/operator docs describe DB-owned runtime state and do not instruct users to consume generated .pipeline/runs/<runId>/schedule.yaml for default runs -- Evidence: rg over README.md docs for .pipeline/runs shows only historical/migration notes or no hits
- [ ] #2 End-to-end test starts scheduled local run in a fresh git repo, steps/resumes via DB, and git status contains no .pipeline runtime paths -- Evidence: recorded test output and assertion over git status --porcelain
- [ ] #3 PIPE-91 design doc reflects implemented reality and removes stale 'not yet built' wording if still present -- Evidence: docs diff + rg for 'not yet built' in docs/moka-orchestrator-design.md
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the completion-claim workflow with fresh evidence
- [ ] #2 Run bun run typecheck, bun run check, focused runtime-state tests, and rg proof commands; record output
<!-- DOD:END -->
