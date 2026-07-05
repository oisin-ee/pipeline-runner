---
id: PIPE-82.7
title: Enforce hard per-node context budget at execution (agent-node)
status: Done
assignee: []
created_date: "2026-06-14 22:37"
updated_date: "2026-06-14 23:26"
labels:
  - token-engineering
  - runtime
dependencies:
  - PIPE-82.1
  - PIPE-82.2
  - PIPE-82.4
references:
  - /Users/oisin/.claude/plans/federated-sparking-truffle.md
  - src/runtime/agent-node/agent-node.ts
modified_files:
  - src/runtime/agent-node/agent-node.ts
  - src/runtime/agent-node/agent-node.test.ts
parent_task_id: PIPE-82
priority: high
ordinal: 217000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Measure the assembled node prompt and make the context cap a HARD rule: route to a larger-window model when one fits, else fail the node fast with an evidence message. No silent truncation (root-cause discipline — truncation risks correctness).

DEPENDS ON: PIPE-82.1 (estimateTokens), PIPE-82.2 (token_budget config), PIPE-82.4 (size-aware selectNodeModel).

SEAM: src/runtime/agent-node/agent-node.ts. In executeAgentNode, after renderAgentPrompt() and before createRunnerLaunchPlan(), call estimateTokens(prompt) and pass it into the size-aware selectNodeModel (PIPE-82.4). Record the estimate, chosen model, and skipped models in the existing evidence/log path (the node already logs selection reason). If selection returns no fitting model, fail the node with a blocking evidence message: "node context <X>k exceeds <pct>% of every available model window". Extract a pure helper decideNodeModel(prompt, node, budget) so the decision is unit-testable without a live runner.

QUALITY: backward-compatible when token_budget is absent (current dispatch path unchanged); no casts; fail-fast, do not truncate.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 executeAgentNode estimates the assembled prompt via estimateTokens and feeds it to the size-aware selectNodeModel; the estimate, chosen model, and skipped models are recorded in the node evidence/log
- [ ] #2 When no model can hold the node within the cap, the node fails with the blocking evidence message and does NOT dispatch (no truncation)
- [ ] #3 A pure decideNodeModel(prompt, node, budget) helper is extracted and unit-tested in src/runtime/agent-node/agent-node.test.ts: over-budget + small-window-only -> fail message; under-budget -> normal dispatch; absent token_budget -> unchanged
- [ ] #4 npx vitest run (agent-node test) passes and npx tsc --noEmit is clean
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

agent-node enforces the hard per-node cap (decideNodeModel): over-budget nodes fail fast with evidence, no dispatch, no truncation. LIVE-verified on 2.4.0 — a 308148-token node failed with "over token budget ... exceeds 50% of every available model window".

<!-- SECTION:FINAL_SUMMARY:END -->
