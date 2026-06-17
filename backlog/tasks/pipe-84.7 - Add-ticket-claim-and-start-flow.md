---
id: PIPE-84.7
title: Add ticket start flow through shared moka run dispatch
status: Done
assignee: []
created_date: '2026-06-17 10:39'
updated_date: '2026-06-17 14:32'
labels:
  - moka
  - ticket
  - cli
  - run-control
dependencies:
  - PIPE-84.9
  - PIPE-84.10
references:
  - src/commands/ticket-command.ts
  - src/cli/run-resolver.ts
  - src/cli/run-command.ts
  - src/cli/program.ts
  - tests/ticket-command.test.ts
  - tests/moka-run-cli-resolver.test.ts
modified_files:
  - src/commands/ticket-command.ts
  - src/cli/program.ts
  - src/cli/run-command.ts
  - tests/ticket-command.test.ts
  - tests/moka-run-cli-resolver.test.ts
parent_task_id: PIPE-84
priority: high
ordinal: 240300
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement moka ticket start after the claim mutation and shared run dispatch seam exist. start must select the next ready ticket, optionally dry-run the exact moka run command, or claim then invoke the same shared dispatch path used by moka run after resolveMokaRun.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 moka ticket start --dry-run prints the selected ticket and exact moka run command with requested effort and target flags without mutating Backlog; evidence: CLI test snapshots output and unchanged fixture files.
- [x] #2 moka ticket start claims the selected ticket through the BacklogService claim helper, then invokes the shared run dispatch helper used by moka run after resolveMokaRun; evidence: test spies on the shared seam and asserts the selected ticket description/id is passed through.
- [x] #3 ticket-command.ts does not duplicate resolveMokaRun, runMokaSubmitFromCli, execute, detached-run, or run-control branching; evidence: source review/grep confirms ticket-command.ts delegates to the shared helper.
- [x] #4 If no ready ticket exists, start exits with a clear no ready tickets message and does not call BacklogService or the run dispatch helper; evidence: CLI test covers empty-ready graph with zero service calls.
- [x] #5 The command remains deterministic across effort and target flags; evidence: tests cover default local normal, --effort quick, --effort thorough, --target remote, and --read-only where supported.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add a ticket start subcommand that reuses selectNextTicket, delegates claim to the BacklogService-backed helper from PIPE-84.10, resolves run flags through the canonical moka run path, and invokes the shared dispatch helper from PIPE-84.9. Keep dry-run as a formatting path only and do not import remote/local execution internals into ticket-command.ts.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented moka ticket start with dry-run output, deterministic selection, BacklogService claim-before-run, and shared resolved moka run dispatch. Fixed reviewer findings by dispatching the selected ticket as one canonical task argument and rejecting unsupported remote read-only before claim or dispatch. Verified ticket start/run resolver tests, integrated run/ticket suite, broader ticket suite, typecheck, style, verifier PASS, acceptance PASS, and final code review PASS.
<!-- SECTION:FINAL_SUMMARY:END -->
