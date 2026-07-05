---
id: PIPE-93
title: Migrate toolchain to nub identity
status: Done
assignee: []
created_date: "2026-06-28 08:56"
updated_date: "2026-06-28 17:40"
labels:
  - toolchain
  - nub-migration
dependencies: []
priority: medium
ordinal: 314000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation. Migrate this repo onto nub identity (remove pnpm/bun, corepack, tsx, npx). FOLLOW THE PLAYBOOK: ~/dev/agent/docs/nub-migration-playbook.md (rondo RONDO-021 is the reference impl; merged to rondo main 2026-06-28). Pin nub to the current release (github.com/nubjs/nub/releases), identical in mise/Docker/CI.

Ordered steps (playbook sections): 2 keystone (nub pm use nub -> lock.yaml, migrate manifest catalog/overrides/allowBuilds, mise+root scripts -> nub run/nubx, add .node-version) -> 3 runner leaves (tsx/node-strip/npx -> nub/nub watch/nubx) -> 4 install+image sites (CI workflows -> nub ci/nubx; Dockerfiles drop corepack -> npm i -g @nubjs/nub) -> 5 deps gate (if sherif: add syncpack) -> 6 test runner (if jest/expo: .nub in transformIgnorePatterns + NODE_OPTIONS=--no-experimental-vm-modules) -> 8 final verify.

REPO SHAPE: PM=pnpm; workspace=no; mise=yes; tsx=yes; expo/RN markers; Dockerfiles=1
PER-REPO FLAGS: expo/react-native markers detected -> apply playbook 6 jest fix if jest present; 1 Dockerfile

Heed playbook 7 gotchas: mise idiomatic_version_file_enable_tools=[node] (else mise npm: backend fails in clean CI); trust-policy-exclude for any beta/floating dep (ERR_AUBE_TRUST_DOWNGRADE); surgical nub remove (avoid floating-tag drift); add lock.yaml to formatter ignore; fix contract-GENERATED files at source not output; depend: dependenciesMeta.injected is a hard refusal (check first).

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 nub ci exit 0 + reproducible (second run leaves lock.yaml churn-free)
- [ ] #2 nub run typecheck && lint && test && build all exit 0 (test on nub; jest fix applied if expo)
- [ ] #3 deps drift gate enforces if applicable; rg pnpm|bun|corepack|tsx|experimental-strip-types|npx clean of live config/code
- [ ] #4 branch pushed, CI green (or red only on infra unrelated to the migration, documented)
<!-- AC:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [ ] #1 Ran feature-implementation workflow per the playbook; recorded fresh nub ci + full-gate output; verify passed or blocker escalated.
<!-- DOD:END -->
