---
id: PIPE-95
title: Complete Biome->oxc + strict + Effect lint migration (@oisin-ee/oxlint-config)
status: To Do
assignee: []
created_date: '2026-07-01 19:57'
labels:
  - migration
dependencies: []
ordinal: 332000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
pipeline-runner (@oisincoveney/pipeline) was a Biome lint repo, uses Effect (effect@4.0.0-beta.90). Created oxlint.config.ts (extends [core, strict], typeAware+typeCheck) + added oxc deps (@oisin-ee/oxlint-config, oxlint, oxfmt, oxlint-tsgolint) + @mpsuesser/oxlint-plugin-effect. Finish:
- nub install.
- Add oxfmt.config.ts (import ultracite/oxfmt).
- Add the effect preset (import { effect } from @oisin-ee/oxlint-config) scoped to the Effect code; effectMigration on any frontend.
- Remove biome.jsonc + @biomejs/biome; confirm ultracite check uses the oxlint provider.
- Run the gate, fix violations to green.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 biome removed; oxlint + oxfmt + strict + effect preset active
- [ ] #2 ultracite check --type-aware passes (0 errors); tsc passes
<!-- AC:END -->
