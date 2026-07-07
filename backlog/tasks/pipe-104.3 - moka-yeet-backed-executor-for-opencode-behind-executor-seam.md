---
id: PIPE-104.3
title: "moka: yeet-backed executor for opencode behind executor seam"
status: Done
assignee: []
created_date: "2026-07-04 10:56"
updated_date: "2026-07-07 09:47"
labels: []
dependencies:
  - PIPE-104.2
parent_task_id: PIPE-104
priority: high
ordinal: 344000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation. What to build: an executor conforming to moka's existing seam executor: (plan: RunnerLaunchPlan, options: RunnerExecutionOptions) => AgentResult (contracts.ts:370), selected by config alongside the current @opencode-ai/sdk executor — NOT replacing it yet. It spawns `yeet run opencode --format json` (execa, like runner/subprocess.ts), parses the yeet Event JSONL stream (SessionStarted/AssistantText/ToolUse/TurnComplete{usage}/RunResult{exit_code,session_id}/Fatal/Reconnect/Raw) into AgentResult {stdout,exitCode,sessionId,...} and emits the equivalent RunnerEventRecord stream (@oisincoveney/pipeline/events). Uses the generated yeet TS types, not redeclared shapes. Vertical slice: one opencode graph node runs end-to-end through this executor and produces events. Scope: oisin-pipeline src/runtime (new yeet-executor module), config flag to select executor; do NOT touch detach/retry/supervisor (that teardown is a later phase). Research required: yeet Event schema + `yeet run` flags (yeet repo/README), moka executor+RunnerLaunchPlan+AgentResult shapes, execa usage in runner/subprocess.ts. Model recommendation — Claude: Sonnet localized, Opus if the Event→RunnerEventRecord mapping proves subtle (claude 2.1.199); Codex: gpt-5.5-high (cross-format mapping; 0.142.5); OpenCode: MoKa Code Writer default (1.17.12).

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 An opencode graph node executes via the yeet executor and returns a populated AgentResult -- Evidence: integration test runs a node through the yeet executor, asserts stdout/sessionId/exitCode
- [ ] #2 yeet Event stream maps to the same RunnerEventRecord shape moka emits today -- Evidence: unit test maps a fixture Event JSONL to RunnerEventRecord, schema-valid
- [ ] #3 Executor selection is config-gated; SDK executor still default -- Evidence: test both selections resolve the intended executor
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

Groomed 2026-07-04. Un-started, valid, blocked on 104.2. SEAM PATH CORRECTION: the executor seam is src/runtime/contracts/contracts.ts:371-373 (not `contracts.ts:370`). Signature confirmed: `(plan: RunnerLaunchPlan, options: RunnerExecutionOptions) => AgentResult | Promise<AgentResult>`. Existing opencode-SDK executor to sit beside = src/runtime/opencode-session-executor.ts. Subprocess/execa reference = src/runner/subprocess.ts. yeet run flags confirmed in ~/dev/yeet/README.md (`yeet run <harness> <prompt> --format ...`, resume/chat/serve). No yeet executor module exists yet. Keep To Do.

<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->

## created: 2026-07-07 09:47

## Migrated to ENG-18.1 (as a child of ENG-18, not a standalone ticket -- see PIPE-104's dedupe closure comment).

<!-- COMMENTS:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [ ] #1 Run feature-implementation workflow in order
- [ ] #2 Unit + integration tests + typecheck + lint run fresh, output recorded
<!-- DOD:END -->
