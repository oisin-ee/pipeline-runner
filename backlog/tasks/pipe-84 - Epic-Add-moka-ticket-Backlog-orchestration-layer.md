---
id: PIPE-84
title: "Epic: Add moka ticket Backlog orchestration layer"
status: Done
assignee: []
created_date: "2026-06-17 10:36"
updated_date: "2026-06-17 14:54"
labels:
  - moka
  - ticket
  - backlog
  - cli
dependencies: []
references:
  - src/schedule/backlog-context.ts
  - src/runtime/services/repo-io-service.ts
  - src/runtime/services/backlog-service.ts
  - src/cli/run-resolver.ts
  - src/cli/program.ts
  - src/planning/generate.ts
modified_files:
  - src/tickets/backlog-task-store.ts
  - src/tickets/ticket-graph.ts
  - src/tickets/ticket-selection.ts
  - src/tickets/ticket-plan.ts
  - src/tickets/ticket-plan-render.ts
  - src/tickets/apply-ticket-plan.ts
  - src/commands/ticket-command.ts
  - src/cli/program.ts
  - src/cli/run-command.ts
  - src/commands/pipeline-command.ts
priority: high
ordinal: 233000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Add a first-class moka ticket namespace that creates scoped Backlog tickets, validates and sequences the Backlog dependency graph, selects the next ready ticket deterministically, and can start selected tickets through canonical moka run. The feature must use Backlog CLI for mutations, gray-matter for task markdown parsing, @dagrejs/graphlib for graph logic, and zod for agent ticket-plan validation.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 moka ticket graph check, sequence, next, next --claim, create --dry-run, create --apply, and start are available in source CLI help; evidence: bun src/index.ts ticket --help and subcommand help output.
- [x] #2 Read-only commands never modify Backlog task markdown; evidence: CLI tests snapshot fixture task contents before and after graph check, sequence, next, and create --dry-run.
- [x] #3 Mutating commands use Backlog CLI create/edit rather than direct markdown writes; evidence: apply and claim tests assert BacklogService command calls and no direct writes to backlog/tasks.
- [x] #4 ticket create --apply creates an epic parent when no --parent is provided; evidence: apply test asserts parent creation before children.
- [x] #5 ticket start composes selected Backlog ticket with canonical moka run through a shared run dispatch seam; evidence: CLI test spies on the shared run path and proves no duplicate resolver or submission branch.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Implement in dependency batches: RepoIoService-backed task store, graph, selector; read-only CLI; ticket-plan schema and dry-run; apply through Backlog CLI; claim/start; docs. Keep src/cli/program.ts thin by registering a command module. Reuse existing BacklogService for mutations and resolveMokaRun plus an extracted shared run dispatch seam for ticket start; do not duplicate run resolver, submit, or run-control logic.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Implemented the moka ticket Backlog orchestration layer. Source CLI exposes graph check, sequence, next, next --claim, create --dry-run, create --apply, and start. Read-only paths are covered by task-file snapshot tests; mutating paths use BacklogService/Backlog CLI calls; create --apply creates an epic parent when needed; ticket start resolves through the shared moka run dispatcher. Verified graph validity, source CLI help, focused ticket/docs tests (36), broader ticket/docs suite (124), typecheck, check, and specialist verifier/acceptance/final review gates.

<!-- SECTION:FINAL_SUMMARY:END -->
