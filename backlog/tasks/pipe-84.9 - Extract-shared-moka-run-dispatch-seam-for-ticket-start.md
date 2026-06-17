---
id: PIPE-84.9
title: Extract shared moka run dispatch seam for ticket start
status: Done
assignee: []
created_date: '2026-06-17 13:15'
updated_date: '2026-06-17 13:56'
labels:
  - moka
  - ticket
  - cli
  - run-control
dependencies:
  - PIPE-84.6
references:
  - src/cli/program.ts
  - src/cli/run-resolver.ts
  - src/cli/run-command.ts
  - tests/moka-run-cli-resolver.test.ts
  - tests/moka-run-remote-compat.test.ts
  - tests/detached-run.test.ts
  - tests/supervised-run.test.ts
modified_files:
  - src/cli/program.ts
  - src/cli/run-command.ts
  - tests/moka-run-cli-resolver.test.ts
parent_task_id: PIPE-84
priority: high
ordinal: 240100
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Extract the post-resolve moka run dispatch from src/cli/program.ts into a named shared helper so ticket start can invoke the canonical local/remote/detach path without duplicating resolver or submission branching.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The existing moka run action calls a shared run dispatch helper after resolveMokaRun; evidence: tests/moka-run-cli-resolver.test.ts covers local, remote, read-only, effort, and command flags through createCliProgram().
- [x] #2 The helper preserves local runtime, detached local runtime, and remote submit behavior; evidence: focused run CLI tests for run resolver, detached run, supervised run, and moka run remote compatibility pass.
- [x] #3 ticket-command.ts can import or receive the helper without importing runPipelineFromConfig, runMokaSubmitFromCli, or duplicating resolution branches; evidence: source review/grep shows those branches live in the shared helper only.
- [x] #4 The change keeps expected failures in typed testable seams rather than console-only side effects; evidence: tests inject or spy on the shared helper through createCliProgram options or an exported seam.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Create src/cli/run-command.ts or an equivalent named helper that accepts the resolved run execution, task, flags, and injectable dependencies. Move the body of the current runAction dispatch there, leave src/cli/program.ts responsible for Commander parsing and resolveMokaRun, and preserve existing run behavior before wiring ticket start.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Extracted shared post-resolve moka run dispatch into src/cli/run-command.ts and wired createCliProgram({ runCommand }) as an injectable seam. Verified focused run CLI suite, broader ticket suite, typecheck, style check, verifier PASS, acceptance PASS, and final code review PASS.
<!-- SECTION:FINAL_SUMMARY:END -->
