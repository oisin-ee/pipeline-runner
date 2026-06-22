---
id: PIPE-89.3
title: Validate consolidated agent asset contracts
status: Done
assignee: []
created_date: '2026-06-22 21:03'
updated_date: '2026-06-23 00:28'
labels: []
dependencies:
  - PIPE-89.2
references:
  - /Users/oisin/dev/agent
parent_task_id: PIPE-89
priority: high
ordinal: 256000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: validate oisin-ee/agent repository shape, skill discovery, hook tests, rules concat, and stale source references.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Skills are discoverable and install from top-level skills/ -- Evidence: scratch npx --yes skills add ./skills --skill '*' --agent opencode --global --yes --copy in temp HOME
- [x] #2 Hook tests pass from hooks/ after path relocation -- Evidence: sh hooks/tests/*.test.sh output
- [x] #3 Rules concatenate from top-level rules/*.md -- Evidence: scripts/generate-rules.sh --stdout output includes expected ordered sections
- [x] #4 Docs and installed rules no longer name old repos as canonical -- Evidence: grep for stale repo names reviewed
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Met. In scratch HOME `/var/folders/_v/3vzdptt941qblmgyksy53g780000gn/T/opencode/agent-skills-home.RHObZP`, `HOME=... npx --yes skills add ./skills --skill '*' --agent opencode --global --yes --copy` found and installed 39 skills from `/Users/oisin/dev/agent/skills`; installed tree contains 39 directories under `.agents/skills`, including `trace`, `verify`, and `dispatch`. `node scripts/audit-skills.mjs` returned `OK: 39 skills audited`. `for test_file in hooks/tests/*.test.sh; do sh "$test_file" || exit 1; done` passed all hook tests. `sh scripts/generate-rules.sh --stdout` printed ordered rule sections beginning with `# Caveman Mode` and included `Global rules come from oisin-ee/agent/rules`. Exact stale split-repo grep found no files for `oisin-ee/(skills|rules|agent-hooks)`, `oisincoveney/skills`, or `/Users/oisin/dev/(skills|agent-rules|agent-hooks)`. `git diff --check` produced no output.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Run the ticket's agent-rules workflow in order
- [x] #2 Run proof command/check and record output
<!-- DOD:END -->
