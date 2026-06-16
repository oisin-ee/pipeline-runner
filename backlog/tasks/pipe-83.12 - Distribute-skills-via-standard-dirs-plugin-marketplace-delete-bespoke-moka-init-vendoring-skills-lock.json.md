---
id: PIPE-83.12
title: >-
  Distribute skills via standard dirs + plugin/marketplace; delete bespoke moka
  init vendoring + skills-lock.json
status: To Do
assignee: []
created_date: '2026-06-15 17:36'
labels:
  - standardization
  - skills
dependencies: []
references:
  - src/pipeline-init.ts
  - skills-lock.json
  - src/install-commands.ts
parent_task_id: PIPE-83
priority: high
ordinal: 230000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workstream E (standardization). Research finds moka init's `npx skills add ... --copy` vendoring + skills-lock.json is the most redundant piece: harnesses already discover `.agents/skills` / `.claude/skills` / global `~/.config/agents/skills`, and Claude Code plugins + a private marketplace give versioned, ref/sha-pinned, per-repo-inheritable distribution that beats vendoring (no lockfile drift, no per-repo copy). Personal scope gives a single user zero-setup cross-project skills.

Adopt standard skills dirs and/or a marketplace/plugin for distribution; delete the bespoke vendoring + lockfile. Keep the two-repo reality in mind (skill bodies still authored in oisin-ee/skills — see memory project_skills_distribution).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Skills are distributed via standard harness dirs and/or a versioned plugin marketplace, not per-project --copy vendoring
- [ ] #2 Bespoke vendoring path + skills-lock.json removed (or reduced to a marketplace ref)
- [ ] #3 A fresh repo gets the standard skill set via one inherited mechanism with no per-repo copy step
- [ ] #4 A single user gets cross-project skills with zero per-repo setup (personal scope)
<!-- AC:END -->
