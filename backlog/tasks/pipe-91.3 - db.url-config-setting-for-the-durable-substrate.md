---
id: PIPE-91.3
title: db.url config setting for the durable substrate
status: To Do
assignee: []
created_date: '2026-06-26 17:21'
labels: []
dependencies: []
references:
  - docs/moka-orchestrator-design.md
modified_files:
  - src/moka-global-config.ts
parent_task_id: PIPE-91
priority: high
ordinal: 277000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation (config-first — express the feature as a config entry, TS only for the missing primitive)
Scope: add the durable-substrate connection setting to moka config following the existing config-schema pattern (zod, strict, URL refine — see mcpGatewaySchema.url / durabilitySchema). db.url points at the cluster Postgres (decision #8: ONE store, no sqlite/Turso). Surface it in the GLOBAL moka config (src/moka-global-config.ts momokaya.*) since the DB URL is environment/cluster-level, not per-repo — alongside the existing momokaya.kubernetes/submit blocks. Validate URL shape; absent db.url -> store selection falls back to in-memory (back-compat).
NOTE open question (also in the epic): whether the per-run durability.enabled toggle stays in pipeline.yaml (durabilitySchema) or consolidates under this global db.url.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 db.url parses + validates from the global moka config; a non-URL value is rejected with a config issue -- Evidence: schema unit test accepts a valid postgres URL, rejects a non-URL string
- [ ] #2 Absent db.url -> store resolution returns the in-memory impl (no crash) -- Evidence: unit test resolving the store with no db.url returns the in-memory store
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the feature-implementation workflow in order
- [ ] #2 pnpm run check + config schema unit tests ran fresh; output recorded
<!-- DOD:END -->
