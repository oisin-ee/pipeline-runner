---
id: PIPE-84.8
title: Document moka ticket workflow and command guidance
status: Done
assignee: []
created_date: '2026-06-17 10:39'
updated_date: '2026-06-17 14:53'
labels:
  - moka
  - ticket
  - docs
dependencies:
  - PIPE-84.4
  - PIPE-84.5
  - PIPE-84.6
  - PIPE-84.7
references:
  - README.md
  - docs/operator-guide.md
modified_files:
  - README.md
  - docs/operator-guide.md
parent_task_id: PIPE-84
priority: high
ordinal: 241000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Document the moka ticket workflow after the command surface lands. The docs must make the boundary clear: moka ticket scopes/selects Backlog work, Backlog CLI owns task mutation, and moka run executes selected work.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 README documents moka ticket create --dry-run, create --apply, graph check, sequence, next, next --claim, and start; evidence: docs test or grep assertion covers the command examples.
- [x] #2 Docs state mutation boundaries: graph check, sequence, next, and create --dry-run are read-only; --claim, create --apply, and start mutate Backlog or run work; evidence: README section includes these exact distinctions.
- [x] #3 Docs instruct agents to use Backlog CLI for task creation and editing instead of direct markdown edits; evidence: README or generated command guidance includes the rule.
- [x] #4 Docs explain that moka ticket selects/scopes work and moka run executes work; evidence: command surface section leads with that relationship, not moka submit as the primary local path.
- [x] #5 Verification records source CLI help and repository checks; evidence: final summary includes bun src/index.ts ticket --help, subcommand help, bun run typecheck, bun run check, and focused ticket tests.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Update README and any generated command guidance once commands exist. Keep docs aligned with canonical moka run guidance from PIPE-54. Do not document unfinished flags before their implementation tickets pass.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Documented moka ticket workflow in README and operator guide, including read-only versus mutating boundaries, Backlog CLI mutation guidance, and ticket/run relationship. Added docs coverage for command examples and boundaries. Verified focused docs/ticket tests (36), broader ticket/docs suite (124), typecheck, check, source CLI help, verifier, acceptance, and final review.
<!-- SECTION:FINAL_SUMMARY:END -->
