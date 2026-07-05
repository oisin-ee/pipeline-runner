---
id: PIPE-84.4
title: Register read-only moka ticket query commands
status: Done
assignee: []
created_date: "2026-06-17 10:37"
updated_date: "2026-06-17 12:35"
labels:
  - moka
  - ticket
  - cli
dependencies:
  - PIPE-84.1
  - PIPE-84.2
  - PIPE-84.3
references:
  - src/cli/program.ts
  - src/commands/pipeline-command.ts
  - src/config/lint.ts
modified_files:
  - src/commands/ticket-command.ts
  - src/cli/program.ts
  - src/commands/pipeline-command.ts
  - tests/ticket-command.test.ts
  - tests/config.test.ts
parent_task_id: PIPE-84
priority: high
ordinal: 237000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Add the read-only moka ticket command namespace for graph validation, sequence rendering, and next-ticket selection. This ticket owns the command registration and output formatting for non-mutating ticket queries only.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 bun src/index.ts ticket graph check --help, ticket sequence --help, and ticket next --help show the read-only query commands; evidence: CLI help test or captured command output.
- [x] #2 moka ticket graph check passes valid graphs and fails missing dependencies or cycles with actionable messages; evidence: tests/ticket-command.test.ts uses temp Backlog fixtures.
- [x] #3 moka ticket sequence --plain prints stable dependency batches; evidence: CLI test asserts exact plain output for a representative graph.
- [x] #4 moka ticket next --json returns selected ticket records and does not mutate task markdown; evidence: CLI test snapshots fixture task contents before and after.
- [x] #5 src/cli/program.ts remains thin and delegates ticket implementation to src/commands/ticket-command.ts; evidence: code review or focused test shows command implementation lives in the ticket command module.
- [x] #6 ticket is reserved as a builtin command for config linting so configured entrypoints cannot silently shadow it; evidence: BUILTIN_PIPE_COMMANDS/config lint test covers ticket.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Add src/commands/ticket-command.ts and register it from src/cli/program.ts before configured entrypoint commands are registered. Add ticket to BUILTIN_PIPE_COMMANDS so config linting reports a shadowed entrypoint if package config later defines one. Wire only graph check, sequence, and next read-only paths. Do not add --claim, create, apply, start, or moka run coupling in this ticket.

<!-- SECTION:PLAN:END -->
