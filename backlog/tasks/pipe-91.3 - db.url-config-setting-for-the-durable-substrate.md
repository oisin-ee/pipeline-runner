---
id: PIPE-91.3
title: >-
  Global db.url durability setting — presence enables, remove pipeline.yaml
  durability block
status: Done
assignee: []
created_date: "2026-06-26 17:21"
updated_date: "2026-06-26 19:14"
labels: []
dependencies: []
references:
  - docs/moka-orchestrator-design.md
modified_files:
  - src/moka-global-config.ts
  - src/config/schemas.ts
  - src/config/load.ts
  - src/pipeline-runtime.ts
parent_task_id: PIPE-91
priority: high
ordinal: 277000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation (config-first — express the feature as a config entry; TS only for the missing primitive)
Scope: consolidate the durable-substrate switch onto a SINGLE global db.url (locked decision, 2026-06-26). Add db.url under the global moka config momokaya.\* (src/moka-global-config.ts) alongside the existing kubernetes/submit blocks — the DB URL is environment/cluster-level, not per-repo. Its PRESENCE is the enable signal: db.url set -> durable Postgres substrate; db.url absent -> in-memory/file behaviour (back-compat, byte-identical to today). There is NO separate enabled boolean.
REMOVE the per-repo pipeline.yaml durability block: delete durabilitySchema (src/config/schemas.ts) and its two optional fields (pipelineFileSchema ~line 866 and the full pipeline schema ~line 912); migrate/clean its consumers — durabilityField (src/config/load.ts) and resolveRunJournal (src/pipeline-runtime.ts:201, which today reads context.config.durability.enabled/.dir). resolveRunJournal must switch on global db.url presence instead of the per-repo toggle.
Back-compat / deprecation (locked decision): a repo whose pipeline.yaml still sets durability.enabled / durability.dir must NOT silently no-op (rules forbid swallowed config / silent fallback). Define the path: on load, a still-present durability key emits a structured deprecation diagnostic naming the global db.url replacement, then is ignored; substrate selection is governed solely by global db.url. Validate the db.url shape with the existing strict URL refine pattern (mcpGatewaySchema.url).
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 pnpm run check + config schema unit tests ran fresh; output recorded
<!-- DOD:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 db.url parses + validates from the global moka config (momokaya.\*); a non-URL value is rejected with a config issue -- Evidence: schema unit test accepts a valid postgres URL, rejects a non-URL string
- [ ] #2 Presence of db.url is the enable signal: set yields the Postgres store, absent yields the in-memory/file store (no crash, back-compat) -- Evidence: unit test resolves the store both with and without db.url and asserts the two store types
- [ ] #3 pipeline.yaml durability block is removed: durabilitySchema deleted, both schema usages plus the load.ts and pipeline-runtime.ts consumers migrated to global db.url -- Evidence: pnpm run check green; grep shows no durabilitySchema or context.config.durability references remain
- [ ] #4 A pipeline.yaml still setting durability surfaces a structured deprecation diagnostic (not a silent no-op) and falls back to global db.url semantics -- Evidence: unit test loads a config carrying a legacy durability block and asserts the emitted deprecation diagnostic
<!-- AC:END -->
