---
id: PIPE-89.4
title: Update oisin-pipeline installers to use oisin-ee/agent
status: Done
assignee: []
created_date: '2026-06-22 21:03'
updated_date: '2026-06-23 00:47'
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
- [x] #1 Skills installer invokes npx skills add oisin-ee/agent/skills with existing global agent args -- Evidence: tests assert execa args
- [x] #2 Hooks installer clones oisin-ee/agent and reads hooks/claude-code, hooks/codex, hooks/opencode -- Evidence: install-hooks and CLI tests use fake repo with hooks/<host> layout
- [x] #3 Rules installer clones oisin-ee/agent and generates from rules/*.md -- Evidence: install-rules tests assert source and generated output
- [x] #4 Global harness install semantics stay unchanged -- Evidence: pipeline-init tests still assert global host dirs and no repo-local .pipeline config
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Met in commit `ede4612`. Added shared `src/agent-assets.ts` constants for `oisin-ee/agent`, `oisin-ee/agent/skills`, `hooks`, and `rules`. `src/pipeline-init.ts` now calls `npx --yes skills add oisin-ee/agent/skills` with existing `--agent opencode --agent codex --agent claude-code --skill * --yes --global` args. `src/install-hooks.ts` clones `oisin-ee/agent` and reads `hooks/<host>`. `src/install-rules.ts` clones `oisin-ee/agent` and builds from `rules/*.md`. Verification: `bun run test -- tests/pipeline-init.test.ts tests/install-hooks.test.ts tests/install-rules.test.ts tests/cli.test.ts` passed 78/78; `bun run typecheck` passed; `bun run build` passed; `bun run check` passed; `git diff --check` clean. Pre-commit repeated `ultracite check`, fallow audit, and `tsc --noEmit` successfully.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Run the ticket's agent-rules workflow in order
- [x] #2 Run proof command/check and record output
<!-- DOD:END -->
