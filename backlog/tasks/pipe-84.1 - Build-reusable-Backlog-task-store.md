---
id: PIPE-84.1
title: Build reusable Backlog task store
status: Done
assignee: []
created_date: '2026-06-17 10:37'
updated_date: '2026-06-17 12:35'
labels:
  - moka
  - ticket
  - backlog
dependencies: []
references:
  - src/schedule/backlog-context.ts
  - src/runtime/services/repo-io-service.ts
  - package.json
modified_files:
  - src/tickets/backlog-task-store.ts
  - tests/ticket-backlog-store.test.ts
parent_task_id: PIPE-84
priority: high
ordinal: 234000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create a reusable read-only task store for moka ticket commands. It must load backlog/tasks markdown, parse frontmatter and task body into typed records, preserve dotted ids, and expose actionable parse errors without mutating Backlog files.
<!-- SECTION:DESCRIPTION:END -->


## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add src/tickets/backlog-task-store.ts. Use gray-matter already present in package dependencies. Use the existing RepoIoService pattern from src/schedule/backlog-context.ts for repository reads so tests can inject temp or fake IO. Reuse or extract acceptance criteria marker parsing conventions from src/schedule/backlog-context.ts where practical, but keep schedule-specific planning context separate unless a shared parser naturally emerges.
<!-- SECTION:PLAN:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Parses id, title, status, priority, ordinal, parent_task_id, dependencies, description, acceptance criteria, references, and modified_files from representative Backlog task markdown; evidence: tests/ticket-backlog-store.test.ts asserts every field from temp fixtures.
- [x] #2 Preserves dotted Backlog ids such as PIPE-41.7 and natural task ids; evidence: fixture test asserts parsed ids and parent relationships.
- [x] #3 Reports duplicate ids and malformed required frontmatter with task file path and field name; evidence: tests assert actionable error messages.
- [x] #4 Reads task markdown through RepoIoService or an equivalent injected repository-IO seam instead of unmockable direct filesystem calls; evidence: tests provide temp or fake IO and code review shows no direct fs reads in the ticket store.
- [x] #5 Does not mutate Backlog files; evidence: tests compare fixture contents before and after loading.
<!-- AC:END -->
