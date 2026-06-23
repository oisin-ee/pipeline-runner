---
id: PIPE-89.6
title: Prove real scratch installs and test suites
status: Done
assignee: []
created_date: '2026-06-22 21:03'
updated_date: '2026-06-23 09:26'
labels: []
dependencies:
  - PIPE-89.5
references:
  - tests/pipeline-init.test.ts
  - tests/install-hooks.test.ts
  - tests/install-rules.test.ts
parent_task_id: PIPE-89
priority: high
ordinal: 259000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: completion-claim
Scope: verify consolidated source and pipeline behavior with real scratch installs and full relevant test suites.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Real npx skills add oisin-ee/agent/skills installs expected skills in temp HOME -- Evidence: command output and installed files
- [x] #2 Real moka init installs skills, hooks, and rules from oisin-ee/agent into temp HOME -- Evidence: non-check moka init output plus generated host files
- [x] #3 moka init --check passes after install -- Evidence: command output
- [x] #4 Pipeline tests and checks pass -- Evidence: targeted installer tests, bun run typecheck, bun run test, bun run build
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Met. Direct real skill install: `HOME=/var/folders/_v/3vzdptt941qblmgyksy53g780000gn/T/opencode/pipe89-skills.JDQlii XDG_CONFIG_HOME=... npx --yes skills add oisin-ee/agent/skills --skill '*' --agent opencode --global --yes --copy` cloned `https://github.com/oisin-ee/agent.git`, found/installed 39 skills, and installed `trace`, `verify`, `dispatch`. Real `moka init` final scratch: `SCRATCH=/var/folders/_v/3vzdptt941qblmgyksy53g780000gn/T/opencode/pipe89-final.lppwRP`; non-check `node dist/index.js init --force` cloned `oisin-ee/agent` for hooks/rules, installed 39 skills, wrote hooks, wrote 4 rules, and generated no repo-local pipeline config files. Final `node dist/index.js init --check` on the same scratch passed with `✓ All files are up to date` and `harness verified; no changes written`. Generated file evidence: scratch OpenCode config contains `mcp.pipeline-gateway`, `lsp: true`, and plugins `@devtheops/opencode-plugin-otel@1.1.0`, `@prevalentware/opencode-goal-plugin`, `oc-codex-multi-auth@6.3.2`; hook manifest contains only `.opencode/plugin/*` and `.opencode/tui.json`, not `.opencode/opencode.json`; OpenCode `AGENTS.md` references `oisin-ee/agent/rules` and `oisin-ee/agent/hooks`. During verification, an old remote hook asset bug was found and fixed: agent commit `8063944` removed `hooks/opencode/opencode.json`, and pipeline commit `30dae98` prevents hook installs from touching or deleting command-owned `.opencode/opencode.json`, including old hook manifests. Red proof: `bun run test -- tests/install-hooks.test.ts` first failed 2 tests because hook install created/overwrote `.opencode/opencode.json`; after fix it passed 7/7. Final checks: targeted installer suite `bun run test -- tests/pipeline-init.test.ts tests/install-hooks.test.ts tests/install-rules.test.ts tests/cli.test.ts` passed 79/79; `bun run typecheck` passed; `bun run check` passed; `git diff --check` clean; `bun run build` passed; final full `bun run test` passed 116 files, 909 tests, 4 skipped.
<!-- SECTION:FINAL_SUMMARY:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Run the ticket's agent-rules workflow in order
- [x] #2 Run proof command/check and record output
<!-- DOD:END -->
