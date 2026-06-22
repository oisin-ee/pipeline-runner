---
id: PIPE-89.4
title: Update oisin-pipeline installers to use oisin-ee/agent
status: To Do
assignee: []
created_date: '2026-06-22 21:03'
labels: []
dependencies:
  - PIPE-89.3
modified_files:
  - src/pipeline-init.ts
  - src/install-hooks.ts
  - src/install-rules.ts
  - tests/pipeline-init.test.ts
  - tests/install-hooks.test.ts
  - tests/install-rules.test.ts
  - tests/cli.test.ts
parent_task_id: PIPE-89
priority: high
ordinal: 257000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: update moka init skills, rules, and hooks installers to consume oisin-ee/agent; hooks read hooks/<host>; rules read rules/*.md; skills use oisin-ee/agent/skills.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Skills installer invokes npx skills add oisin-ee/agent/skills with existing global agent args -- Evidence: tests assert execa args
- [ ] #2 Hooks installer clones oisin-ee/agent and reads hooks/claude-code, hooks/codex, hooks/opencode -- Evidence: install-hooks and CLI tests use fake repo with hooks/<host> layout
- [ ] #3 Rules installer clones oisin-ee/agent and generates from rules/*.md -- Evidence: install-rules tests assert source and generated output
- [ ] #4 Global harness install semantics stay unchanged -- Evidence: pipeline-init tests still assert global host dirs and no repo-local .pipeline config
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the ticket's agent-rules workflow in order
- [ ] #2 Run proof command/check and record output
<!-- DOD:END -->
