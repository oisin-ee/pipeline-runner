---
id: PIPE-49.11
title: Document Console to runner-job contract
status: Done
assignee: []
created_date: "2026-06-05 12:27"
updated_date: "2026-07-04 19:42"
labels:
  - runner-job
  - docs
  - contract
dependencies:
  - PIPE-49.9
references:
  - docs/pipeline-console-runner-contract.md
  - src/runner-command-contract.ts
modified_files:
  - docs
parent_task_id: PIPE-49
priority: high
ordinal: 127000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Document the architectural boundary and payload/env contract for Pipeline Console, runner jobs, and devspace repositories.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Docs state Pipeline Console passes parameters/secrets and does not generate ticket-specific schedules.
- [x] #2 Docs state runner-job owns checkout, /workspace, devspace readiness, schedule generation, and event emission.
- [x] #3 Docs list required payload fields and required secret/env variables.
- [x] #4 Docs describe stable repo assets versus run artifacts.
- [x] #5 Docs mention no compatibility shim and no kubernetes-runner surface.
- [x] #6 Docs state successful runner-job pipeline runs create a GitHub PR after verification and publish the PR URL as run evidence.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Write concise contract documentation referencing exported JSON schema and runner-job module boundaries.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Done. docs/pipeline-console-runner-contract.md (233 lines, commits d9dd587 / 57782b9) documents the full boundary. Ticket ref src/runner-job-contract.ts is stale — the exported contract is src/runner-command-contract.ts (@oisincoveney/pipeline/runner-command-contract).

Evidence (all against docs/pipeline-console-runner-contract.md):

- AC#1 Console passes params/secrets and does not generate schedules — "Console Workflow Payload" + "Payloads describe run identity, repository/task intent, delivery intent, and the Console event destination. They must not carry workflow selectors, entrypoints, workspace modes ... or secrets"; the runner "generates a task-specific moka schedule artifact".
- AC#2 runner owns checkout, /workspace, devspace readiness, schedule generation, event emission — "The runner clones repository.url into /workspace, checks out a pipeline/<...> branch ... generates a task-specific moka schedule artifact, and then invokes the pipeline engine"; Event Batches section covers emission.
- AC#3 required payload fields + required secret/env vars — the payload JSON schema block + the "Authentication" section (BROKER_API_KEY, event-auth mount, MCP gateway auth, git credentials, GitHub CLI auth).
- AC#4 stable repo assets vs run artifacts — "Stable runtime config is package-owned. Repo-local artifacts are schedules, worktrees, agent prompts, logs, reports, verification evidence, and PR metadata."
- AC#5 no compat shim / no kubernetes-runner surface — Boundary section: "there is no compatibility shim or kubernetes-runner surface."
- AC#6 successful runs create a GitHub PR after verification and publish the PR URL as evidence — "Environment Setup And PR Delivery" (gh pr create after passing verification) + "The PR URL is emitted as run evidence when delivery succeeds."
<!-- SECTION:FINAL_SUMMARY:END -->
