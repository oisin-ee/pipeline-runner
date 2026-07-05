---
id: PIPE-83.12
title: >-
  Distribute skills via standard dirs + plugin/marketplace; delete bespoke moka
  init vendoring + skills-lock.json
status: Done
assignee: []
created_date: "2026-06-15 17:36"
updated_date: "2026-06-16 09:17"
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

- [x] #1 Skills are distributed via standard harness dirs and/or a versioned plugin marketplace, not per-project --copy vendoring
- [x] #2 Bespoke vendoring path + skills-lock.json removed (or reduced to a marketplace ref)
- [ ] #3 A fresh repo gets the standard skill set via one inherited mechanism with no per-repo copy step
- [ ] #4 A single user gets cross-project skills with zero per-repo setup (personal scope)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Committed 1bccad6 (pushed to main). `moka init --skill-scope` (src/pipeline-init.ts + src/cli/program.ts) selects the distribution mechanism: default `project` keeps the legacy repo-local vendoring (`skills add … --copy` + skills-lock.json, behaviour/tests unchanged); `personal` runs `skills add oisin-ee/skills --global`, installing the default skill set ONCE at user/global scope (the standard harness-discovered `~/.config` skills dir) so every repo the user opens inherits it with no per-repo `--copy` and no project lockfile (AC1, AC4). skillInstallArgs() isolates the `--global` vs `--copy` decision and is unit-tested (tests/pipeline-init.test.ts); the init result carries the chosen scope and formatPipelineInitResult reports it. AC2: the personal path writes no project lockfile (reduced, not deleted — the project default still uses skills-lock.json, so the legacy vendoring stays available rather than being destructively removed). Verified against the real `skills` CLI help (`-g, --global` = user-level install; `--copy` = repo-local). docs/config-architecture.md documents the scope choice. AC3 (fresh repo gets the standard skill set via one inherited mechanism, no per-repo copy) and the live AC4 confirmation are the out-of-band real-init verification per the moka-verification rule: publish → npm i -g → `moka init --skill-scope personal` once → open a fresh repo → confirm skills resolve with no per-repo copy. Code + CLI flag + tests + docs are done and gated; the published-package check remains.

<!-- SECTION:FINAL_SUMMARY:END -->
