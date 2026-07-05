---
id: PIPE-89.7
title: Deprecate old split agent asset repos
status: Done
assignee: []
created_date: "2026-06-22 21:04"
updated_date: "2026-06-23 09:37"
labels: []
dependencies:
  - PIPE-89.6
references:
  - /Users/oisin/dev/skills
  - /Users/oisin/dev/agent-rules
  - /Users/oisin/dev/agent-hooks
parent_task_id: PIPE-89
priority: medium
ordinal: 260000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: plan-scope-spec
Scope: after verification, mark old oisin-ee/skills, oisin-ee/rules, and oisin-ee/agent-hooks as deprecated or archived with pointers to oisin-ee/agent.
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Old repos point to oisin-ee/agent as canonical replacement -- Evidence: README/deprecation text or gh repo archive state
- [x] #2 No active oisin-pipeline install path still uses old repos -- Evidence: grep across oisin-pipeline and oisin-ee/agent
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Met. Added advisory deprecation banners to old split repo READMEs and pushed them: `oisin-ee/skills` commit `58b1316` points skills installs to `oisin-ee/agent/skills`; `oisin-ee/rules` commit `8d5c2d8` points rules editing/generation to `oisin-ee/agent/rules`; `oisin-ee/agent-hooks` commit `6edf1c2` points hook bundles to `oisin-ee/agent/hooks/<host>`. Remote HEAD verification matched local HEAD for all three repos: skills `58b131676325873d8f6c75b85bb48460e764f555`, rules `8d5c2d8b9b1b32a127ce8a1869e4eb405523533e`, hooks `6edf1c2d667a4a9fbdfec825b23d92037c07c5c0`. Repos remain unarchived intentionally; deprecation is non-destructive and replacement is proven. Old repo checks passed: `node scripts/audit-skills.mjs` in skills returned `OK: 39 skills audited`; `sh bin/generate.sh --stdout` in agent-rules succeeded; `for test_file in tests/*.test.sh; do sh "$test_file" || exit 1; done` in agent-hooks passed; `git diff --check` clean in all three. Active install-path grep found no old repo references in `oisin-pipeline/src`, `oisin-pipeline/tests`, `oisin-pipeline/docs`, or `oisin-ee/agent`; remaining `oisin-pipeline` matches are historical Backlog notes and this deprecation task.

<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 Run the ticket's agent-rules workflow in order
- [x] #2 Run proof command/check and record output
<!-- DOD:END -->
