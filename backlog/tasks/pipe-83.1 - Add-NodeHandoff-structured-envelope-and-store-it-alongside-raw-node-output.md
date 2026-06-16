---
id: PIPE-83.1
title: Add NodeHandoff structured envelope and store it alongside raw node output
status: Done
assignee: []
created_date: '2026-06-15 17:33'
updated_date: '2026-06-15 18:20'
labels:
  - architecture
  - context-engineering
dependencies: []
references:
  - src/runtime/agent-node/agent-node.ts
  - src/token-estimator.ts
  - src/runtime/node-state-store.ts
  - src/runtime/json-validation.ts
  - src/runtime/contracts.ts
parent_task_id: PIPE-83
priority: high
ordinal: 219000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workstream A (keystone). Define a typed handoff envelope so downstream nodes consume curated structure, not raw transcripts. See Implementation Plan for the grounded approach (live-code-verified).

SEAM: new src/runtime/handoff.ts with a Zod NodeHandoff schema { summary, decisions[], artifacts: {path, lineRange}[], testNames[], openQuestions[] }. Produce the handoff by DERIVING it via a cheap per-node finalizer that reuses moka's existing structured-output + repair-runner machinery (NOT a new SDK output-format path — see plan). Store it in NodeStateStore keyed by nodeId next to outputText.

BACKWARD-COMPATIBLE: if no handoff is recorded, consumers fall back to raw outputText so PIPE-82.x and existing consumers are unaffected. No casts/suppressions; explicit reasons.

This envelope is reused by PIPE-83.5 (prompt assembly), PIPE-83.7/.9 (candidate handoffs), and PIPE-83.10 (the unit persisted durably).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 NodeHandoff Zod schema (summary, decisions[], artifacts:{path,lineRange}[], testNames[], openQuestions[]) exists and is exported from src/runtime/handoff.ts
- [x] #2 A cheap per-node finalizer derives a NodeHandoff from the node's raw output (reusing the createOutputRepairPlan read-only-runner pattern); fast-path uses an already-matching structured output without the extra call
- [x] #3 NodeStateStore gains handoffByNode + recordHandoff/handoff(nodeId); forkForParallelChildren COPIES handoffByNode (not shared by reference)
- [x] #4 The handoff is recorded by the runtime caller next to recordOutput via an optional `handoff` field on NodeAttemptResult; a node with no handoff falls back to outputText with no behaviour change
- [x] #5 Unit tests cover schema validation, store round-trip, fork-copy isolation, and the no-handoff fallback path
- [x] #6 npx tsc --noEmit is clean and the relevant vitest suite passes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
GROUNDED against live code (2026-06-15) — two corrections to the original framing:

1. NO new SDK path. moka ALREADY has the structured-output machinery: profiles with output.format=json_schema get the schema injected into the prompt (renderProfileOutputContract, agent-node.ts:511), the returned stdout is validated (validateJsonSchemaSource), and there is an output-REPAIR loop with a cheap read-only finalizer runner (runOutputRepair / createOutputRepairPlan, agent-node.ts:280-418). The handoff must RIDE this pattern, not a hypothetical opencode/Agent-SDK outputFormat.

2. PRODUCE-vs-DERIVE fork (the real design decision): a node's output.format=json_schema is already used for its PRIMARY deliverable (gate verdicts, etc.), so we canNOT just bolt a second top-level schema onto every profile. RECOMMENDATION: DERIVE the NodeHandoff via a cheap per-node finalizer step that mirrors createOutputRepairPlan — a tiny read-only model reads the raw output (+ changed files) and emits a NodeHandoff. Uniform, works for gate nodes too, no per-profile change. Fast-path: if a node already emits structured output matching the handoff shape, use it directly and skip the extra call.

STORAGE: NodeStateStore.lastOutputByNode is Map<string,string>; add a parallel handoffByNode: Map<string, NodeHandoff> + recordHandoff/handoff(nodeId). CRITICAL: forkForParallelChildren (node-state-store.ts:24) currently SHARES structuredOutputs by reference across parallel children — handoffByNode must be COPIED like lastOutputByNode, or candidate runs (PIPE-83.7) cross-contaminate. Record the handoff in the runtime caller next to recordOutput, via a new optional `handoff` field on NodeAttemptResult (contracts.ts).

CONSUMPTION (lands in PIPE-83.5): BOTH bloat sites change — node.needs raw dump (agent-node.ts:469-471) AND inheritedOutputSections (agent-node.ts:539-556, the bigger amplifier: it dumps EVERY transitive ancestor output, not just the chain).

FALLBACK: if no handoff recorded, consumers fall back to outputText (current behaviour) — satisfies the synthesized-minimal-handoff AC.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
SLICE 1 LANDED (branch pipe-83-context-handoff, uncommitted) — the non-breaking DATA LAYER, fully verified (tsc clean, ultracite check clean, 12/12 vitest green):
- src/runtime/handoff.ts: NodeHandoff zod schema + type; parseHandoff (fence-tolerant, null on miss); synthesizeMinimalHandoff (fallback); renderHandoff (for 83.5); handoffFinalizerPrompt (for the derive call).
- NodeStateStore: handoffByNode map + recordHandoff/handoff(); forkForParallelChildren COPIES it (test proves no cross-contamination, unlike the shared structuredOutputs).
- contracts.ts: optional handoff?: NodeHandoff on NodeAttemptResult.
- tests: handoff.test.ts (8) + 2 added to node-state-store.test.ts.
Zero behaviour change (nothing consumes the field yet) so PIPE-57 goldens are untouched.

SLICE 2 REMAINING (AC #2, #4, #5-fallback): wire the derive finalizer into executeAgentNode (mirror createOutputRepairPlan: fast-path parseHandoff(rawOutput) -> else cheap finalizer call), attach to NodeAttemptResult.handoff, and recordHandoff at the recordOutput site in pipeline-runtime.ts. GATE behind a default-OFF config flag so goldens stay put until PIPE-83.5 consumes handoffs. Route the finalizer to a cheap model tier (cost-aware-models).
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Committed 393df36 on branch pipe-83-context-handoff. NodeHandoff envelope (src/runtime/handoff.ts: zod schema, parseHandoff, synthesizeMinimalHandoff, handoffFinalizerPrompt) + NodeStateStore.handoffByNode/recordHandoff/handoff() (copied, not shared, into parallel forks). agent-node derives a handoff per node via a cheap read-only finalizer (mirrors createOutputRepairPlan) with a fast-path for already-handoff-shaped output and a synthesized fallback; recorded via an optional handoff field on NodeAttemptResult. Gated behind config context_handoff.{enabled,model} (default OFF) so PIPE-57 goldens and existing behaviour are unchanged until PIPE-83.5 consumes handoffs. Verified: tsc clean, ultracite clean, fallow-audit clean (0 introduced findings), full suite 594 passed / 4 skipped. Deferred to PIPE-83.5: renderHandoff (the consumer-side renderer) and wiring renderAgentPrompt to consume handoffs instead of raw transitive text.
<!-- SECTION:FINAL_SUMMARY:END -->
