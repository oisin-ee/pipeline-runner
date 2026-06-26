---
id: PIPE-89
title: Shared AI agent-auth library — unify auth materialization across all consumers
status: To Do
assignee: []
created_date: '2026-06-22 20:28'
labels:
  - epic
dependencies: []
references:
  - oisin-pipeline/src/codex-auth-sync.ts
  - autofix/src/worker/agent-credentials.ts
  - infra/scripts/rotate-codex-accounts.sh
priority: high
ordinal: 253000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Problem: "materialize AI agent auth + wire the runner" is re-implemented per consumer (moka codex-auth-sync.ts, pipeline-runner image Dockerfile/preflight, coder dev-workspace main.tf, autofix worker materializeAgentCredentials). They drift; autofix used a single CODEX_AUTH_JSON -> ~/.codex/auth.json with raw codex and went stale (refresh token already used, 401), failing roborev. 

Scope: extract a shared package @oisin-ee/agent-auth (TS API + CLI) that owns auth materialization + runner wiring as a data table keyed by runner, consuming the shared rotated accounts store. Migrate every consumer to it; drop bespoke copies and per-worker single-token auth. 

Non-goals: changing the credential store (stays OpenBao kv/agent-runtime/pipeline-runner/codex-multiauth-accounts + ESO mirrors) or the rotation script (scripts/rotate-codex-accounts.sh).
<!-- SECTION:DESCRIPTION:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 All child tickets Done with per-criterion evidence
- [ ] #2 No consumer retains a bespoke auth-materialization path or a private single-account CODEX_AUTH_JSON
<!-- DOD:END -->
