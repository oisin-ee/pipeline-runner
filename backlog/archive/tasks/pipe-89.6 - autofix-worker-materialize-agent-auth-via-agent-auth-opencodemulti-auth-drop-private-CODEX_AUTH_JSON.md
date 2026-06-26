---
id: PIPE-89.6
title: >-
  autofix worker: materialize agent auth via agent-auth (opencode+multi-auth),
  drop private CODEX_AUTH_JSON
status: To Do
assignee: []
created_date: '2026-06-22 20:30'
updated_date: '2026-06-22 20:40'
labels: []
dependencies: []
references:
  - src/codex-auth-sync.ts
modified_files:
  - autofix/src/worker/agent-credentials.ts
  - autofix/src/worker/env.ts
parent_task_id: PIPE-89
priority: high
ordinal: 259000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope (autofix repo): replace src/worker/agent-credentials.ts single-CODEX_AUTH_JSON->~/.codex/auth.json with the agent-auth lib/CLI consuming the mounted shared accounts.json; run roborev agent against opencode+oc-codex-multi-auth; remove CODEX_AUTH_JSON from env.ts + worker secret. Cross-repo: github.com/oisin-ee/autofix (no backlog there; tracked here).
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Worker materializes opencode+multi-auth via agent-auth, no CODEX_AUTH_JSON -- Evidence: code review + env.ts no longer references CODEX_AUTH_JSON
- [ ] #2 Live autofix run on a private-dep PR passes the roborev phase (no token_expired/401) -- Evidence: worker log shows agent runs; status past roborev
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order
- [ ] #2 Live autofix run on PR #6 (jalgpall-web) reaches verify/push -- record status + log
<!-- DOD:END -->
