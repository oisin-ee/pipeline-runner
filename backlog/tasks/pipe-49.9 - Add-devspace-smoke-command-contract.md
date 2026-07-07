---
id: PIPE-49.9
title: Add devspace smoke command contract
status: Done
assignee: []
created_date: "2026-06-05 12:27"
updated_date: "2026-07-07 09:47"
labels:
  - runner-job
  - devspace
  - verification
dependencies: []
references:
  - src/config/schemas.ts
  - src/runner-command/run.ts
  - docs/pipeline-console-runner-contract.md
modified_files:
  - src/runner-job/devspace.ts
  - src/config.ts
parent_task_id: PIPE-49
priority: high
ordinal: 125000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Define how a devspace repo declares real smoke/test commands for runner-job verification without hardcoding repository behavior in Pipeline Console.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Stable pipeline config can declare devspace smoke/test commands for runner-job verification.
- [ ] #2 Runner-job discovers the declared command from the clean checkout, not from Console-specific behavior.
- [ ] #3 Configured smoke command failures are reported as runner-job/readiness or verification events with command evidence.
- [ ] #4 Repos without declared smoke commands are handled explicitly according to config policy, not by silent fallback.
- [ ] #5 No devspace smoke logic is added to pipeline runtime or scheduler modules.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Extend stable config schema/defaults if needed, add runner-job devspace smoke resolver, and test command discovery/failure behavior.

<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

Groomed 2026-07-04 (verified against code, not ticket text). Stale refs corrected: src/config.ts -> src/config/schemas.ts; src/pipeline-init.ts and src/runner-job/devspace.ts do NOT exist -- runner logic lives under src/runner-command/.

AC#1 DONE: stable package config declares smoke commands -- runner_command.environment.{setup,smoke} arrays (src/config/schemas.ts:529-530, runnerCommandEnvironmentSchema; defaults setup:[], smoke:[]). Also documented in docs/pipeline-console-runner-contract.md ('Environment Setup And PR Delivery').

REMAINING -- smoke is DECLARED but NOT EXECUTED:

- Runner only runs environment.setup (src/runner-command/run.ts:393 runSetupCommands(...environment.setup...)). No consumer of environment.smoke anywhere in non-test src (grep 'smoke' over src/\*.ts -> only schema declarations + defaults). The doc's 'runner executes smoke after PASS, failed smoke prevents PR' is currently aspirational, not wired.
- AC#2 (runner discovers declared smoke command from clean checkout) -- not implemented.
- AC#3 (configured smoke failures reported as runner.command.phase/verification events with command evidence) -- not implemented.
- AC#4 (repos without declared smoke handled explicitly per config policy, not silent fallback) -- current default smoke:[] is a silent no-op, not an explicit policy.
- AC#5 (no smoke logic in runtime/scheduler) -- still holds; when wiring, add runSmokeCommands next to runSetupCommands in src/runner-command/run.ts (mirror the setup path), NOT in src/runtime or src/planning.

Next step: add a runSmokeCommands step post-PASS in src/runner-command/run.ts that reads environment.smoke, emits runner.command.phase events with command evidence, and gates PR delivery on smoke success.

<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->

## created: 2026-07-07 09:47

## Migrated to ENG-33.1.

<!-- COMMENTS:END -->
