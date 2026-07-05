---
id: PIPE-84.5
title: Add ticket-plan schema and create dry-run
status: Done
assignee: []
created_date: "2026-06-17 10:38"
updated_date: "2026-06-17 12:49"
labels:
  - moka
  - ticket
  - scope
  - cli
dependencies:
  - PIPE-84.1
  - PIPE-84.4
references:
  - defaults/profiles.yaml
  - src/commands/ticket-command.ts
modified_files:
  - src/tickets/ticket-plan.ts
  - src/tickets/ticket-plan-render.ts
  - src/commands/ticket-command.ts
  - src/cli/program.ts
  - src/standard-output-schemas.ts
  - defaults/profiles.yaml
  - tests/ticket-plan.test.ts
  - tests/ticket-command.test.ts
  - tests/config.test.ts
  - tests/install-commands.test.ts
parent_task_id: PIPE-84
priority: high
ordinal: 238000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Add the structured ticket-plan contract for agentic moka ticket create and wire the dry-run command. The scoping agent may propose tickets, but the CLI must validate structured JSON before rendering Backlog commands and must not write tasks in dry-run mode.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Defines a zod ticket-plan schema covering optional epic, child tickets, local dependency keys, acceptance criteria with required evidence text, likely files, priority, and plan text; evidence: tests reject plans missing AC evidence or using unknown dependency keys.
- [x] #2 moka ticket create <request> --dry-run invokes the configured scoping path and validates structured JSON before rendering output; evidence: CLI test stubs the agent result and asserts rendered Backlog commands.
- [x] #3 Dry-run output includes exact backlog task create/edit commands with --parent, --dep, --ac, --plan, --priority, --ref, and --modified-file where present; evidence: snapshot test of dry-run output.
- [x] #4 Dry-run creates no Backlog task files and performs no BacklogService mutations; evidence: temp fixture test compares backlog/tasks before and after.
- [x] #5 The scoper profile or prompt requires the scope skill contract and forbids partial tickets; evidence: defaults/profile test or prompt snapshot includes the binding-ticket instructions.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Add src/tickets/ticket-plan.ts and src/tickets/ticket-plan-render.ts. Extend src/commands/ticket-command.ts with create --dry-run only. Use zod already present in package dependencies. Do not implement --apply in this ticket.

<!-- SECTION:PLAN:END -->
