---
id: PIPE-89.5
title: Update pipeline docs and generated package output
status: Done
assignee: []
created_date: '2026-06-22 21:03'
updated_date: '2026-06-23 00:47'
labels: []
dependencies:
  - PIPE-89.4
modified_files:
  - README.md
  - docs/config-architecture.md
  - docs/operator-guide.md
  - dist
parent_task_id: PIPE-89
priority: medium
ordinal: 258000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: update oisin-pipeline docs to describe oisin-ee/agent and regenerate dist from source.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 README and operator/config docs describe one asset repo oisin-ee/agent -- Evidence: grep for old repo names returns only intentional migration/deprecation references
- [x] #2 dist output reflects source after build, with no hand edits -- Evidence: bun run build and git diff -- dist
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Met in commit `ede4612`. Updated `README.md`, `docs/config-architecture.md`, and `docs/operator-guide.md` to describe one private asset repo, `oisin-ee/agent`, with skills from `oisin-ee/agent/skills`, hooks from `oisin-ee/agent/hooks/<host>`, and rules from `oisin-ee/agent/rules`. Exact stale grep over `src`, `tests`, and `docs` found no files for `oisin-ee/(skills|rules|agent-hooks)` or `oisincoveney/skills`; remaining Backlog references are historical or deprecation-ticket references. `bun run build` succeeded; `git diff -- dist` produced no tracked diff because `dist/` is gitignored in this checkout, so no generated output was hand-edited or committed.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Run the ticket's agent-rules workflow in order
- [x] #2 Run proof command/check and record output
<!-- DOD:END -->
