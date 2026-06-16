---
id: PIPE-82.3
title: Add 'Task sizing & token budget' section to the orchestrate skill
status: Done
assignee: []
created_date: '2026-06-14 22:36'
updated_date: '2026-06-14 23:26'
labels:
  - token-engineering
  - skills
dependencies: []
references:
  - /Users/oisin/.claude/plans/federated-sparking-truffle.md
  - /Users/oisin/dev/skills/skills/orchestrate/SKILL.md
modified_files:
  - .agents/skills/orchestrate/SKILL.md
  - .claude/skills/orchestrate/SKILL.md
parent_task_id: PIPE-82
priority: medium
ordinal: 213000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Encode the research sizing rules into the orchestrate skill so the controller fans out token-efficiently. NOTE: skills are distributed from the SEPARATE oisin-ee/skills repo (local clone /Users/oisin/dev/skills) via `moka init` / `npx skills add` — the canonical file is there; the pipeline repo holds byte-identical vendored copies. This ticket spans both repos and requires a push of oisin-ee/skills.

SEAM: edit canonical /Users/oisin/dev/skills/skills/orchestrate/SKILL.md, run `node scripts/audit-skills.mjs`, then copy byte-identical to .agents/skills/orchestrate/SKILL.md and .claude/skills/orchestrate/SKILL.md in the pipeline repo. Section content (grounded in Anthropic + Chroma): scale fan-out to complexity (1 agent simple / 2-4 comparison / keep code lanes narrow); pass distilled path-based context, not repo dumps; sub-agents return ~1-2k-token summaries; on a gate FAIL re-dispatch ONCE with concentrated evidence (each cold opencode-run re-pays the ~35k standup); default to the smallest roster that covers the work.

This ticket is independent of the code tickets (different files/repo).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Canonical /Users/oisin/dev/skills/skills/orchestrate/SKILL.md gains a 'Task sizing & token budget' section with the fan-out tiers, distilled-context, ~1-2k summary, re-dispatch-once, and smallest-roster rules
- [ ] #2 node scripts/audit-skills.mjs passes
- [ ] #3 The two vendored copies (.agents/skills/orchestrate/SKILL.md and .claude/skills/orchestrate/SKILL.md) are byte-identical to canonical (md5 match)
- [ ] #4 After pushing oisin-ee/skills, a scratch `npx skills add oisin-ee/skills --skill orchestrate --copy` installs a SKILL.md containing the new section
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added "Task sizing & token budget" section to the orchestrate skill (canonical oisin-ee/skills + vendored copies). LIVE-verified: `moka init` on 2.4.0 installs the section into .agents/.claude skills.
<!-- SECTION:FINAL_SUMMARY:END -->
