---
id: PIPE-83.13
title: >-
  Spike: define profiles in native agent formats and make per-node runtime
  pluggable (opencode/claude/goose)
status: Done
assignee: []
created_date: '2026-06-15 17:36'
updated_date: '2026-06-15 18:30'
labels:
  - standardization
  - architecture
  - spike
dependencies: []
references:
  - defaults/profiles.yaml
  - src/runtime/opencode-session-executor.ts
parent_task_id: PIPE-83
priority: medium
ordinal: 231000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workstream E / first-principles end-state. Harness research recommends moka stop hand-rolling profile definitions (which duplicate native opencode `.opencode/agents`, Claude Code `.claude/agents`, Roo modes) and own ONLY the DAG wiring + token-aware model choice ABOVE native agents — shelling each node out to `opencode run` / `claude -p` / `goose run --recipe` so moka becomes runtime-pluggable and multi-vendor.

Evaluate this end-state vs the current opencode-SDK coupling on: multi-vendor reach, the reliability shell (timeout/abort/retry) moka must keep around hang-prone SDKs (opencode #8203/#30439 hang-on-API-error), and where per-category caps + token-aware selection live. Judge by best architecture, not migration cost.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Comparison of current SDK coupling vs runtime-pluggable nodes (opencode run / claude -p / goose run) on multi-vendor reach, reliability, and where caps + token-aware selection live
- [ ] #2 Recommendation on migrating profiles to native agent formats and deleting duplicated profile plumbing
- [ ] #3 Confirmation the reliability shell (timeout/abort/retry/error-propagation) is preserved around any chosen runtime
- [ ] #4 Migration cost explicitly excluded as a decision criterion
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Spike complete (MoKa Researcher, read-only, orchestrated). RECOMMENDATION: migrate persona/profile/grants to native agent formats (.opencode/agents, .claude/agents) and delete the duplicated profile plumbing; KEEP in moka — DAG/workflow config, category + token_budget.fan_out_width caps, node.models + selectNodeModel, the RunnerLaunchPlan launch contract, output schema validation/repair, and gates/retries/lifecycle/evidence. Make each node runtime-pluggable via the EXISTING subprocess reliability shell (runLaunchPlan timeout/abort/streaming/timedOut at runner.ts:392-427), shelling to opencode run / claude -p / goose run; per-runtime adapters only render command/args/env + normalize output. CRITICAL FINDING: the current opencode SDK path's session.prompt is NOT bounded by plan.timeoutMs or options.signal (opencode-session-executor.ts:82-105) — a real hang risk; any retained SDK transport must be wrapped by the same shell. Token-aware selectNodeModel stays ABOVE the runtime and becomes a per-node CLI --model override (never baked into native agent files, since selection is dynamic per prompt size). Migration cost excluded per directive. This corroborates PIPE-83.10's reliability-shell requirement.
<!-- SECTION:FINAL_SUMMARY:END -->
