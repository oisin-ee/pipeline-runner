---
id: PIPE-89
title: 'Epic: Consolidate agent assets into oisin-ee/agent'
status: To Do
assignee: []
created_date: '2026-06-22 21:02'
labels:
  - epic
dependencies: []
references:
  - /Users/oisin/dev/skills
  - /Users/oisin/dev/agent-rules
  - /Users/oisin/dev/agent-hooks
  - /Users/oisin/dev/oisin-pipeline
priority: high
ordinal: 253000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Problem: skills, rules, and hooks are split across oisin-ee/skills, oisin-ee/rules, and oisin-ee/agent-hooks while oisin-pipeline installs all three during moka init. Scope: consolidate into one physical oisin-ee/agent repo with preserved history, no git submodules, then update oisin-pipeline installers, docs, tests, and scratch install proof. Non-goals: deleting old repos before verification; changing global harness semantics.
<!-- SECTION:DESCRIPTION:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 All child tickets are Done with per-criterion evidence
<!-- DOD:END -->
