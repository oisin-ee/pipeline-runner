---
id: PIPE-82
title: "Epic: Token-aware task sizing & budgeting (scheduler + orchestrate skill)"
status: Done
assignee: []
created_date: "2026-06-14 22:35"
updated_date: "2026-06-14 23:26"
labels:
  - epic
  - scheduler
  - token-engineering
dependencies: []
references:
  - /Users/oisin/.claude/plans/federated-sparking-truffle.md
documentation:
  - >-
    https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
  - "https://www.anthropic.com/engineering/multi-agent-research-system"
  - "https://www.trychroma.com/research/context-rot"
  - "https://platform.claude.com/docs/en/build-with-claude/prompt-caching"
priority: high
ordinal: 210000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

WHY: Research (5 Tier-A primaries) shows token usage alone explains ~80% of agent performance variance (Anthropic multi-agent), and context rot degrades output well before the window fills — "a 200K window can exhibit significant degradation at 50K tokens" (Chroma). The pipeline today has ZERO token/context awareness (grep across src/ confirms): model fallback lists are hand-authored, prompts are assembled and sent unmeasured, fan-out is a single global cap.

OUTCOME: Make the scheduler/planner token-aware and enforce HARD rules — a per-node context ceiling (fraction of the chosen model's window) and per-category fan-out caps — with all thresholds in config (config-first) and one new TS primitive (token estimation via js-tiktoken). Plus an orchestrate-skill section encoding the sizing rules.

Full design + source list in the plan doc (see references). Children: token-estimator primitive, token_budget config block (shared contract), size-aware model selection, hard per-node context cap, fan-out width caps, planner awareness, orchestrate skill section. Parallel batches: [estimator, config, skill] → [model-selection, fan-out, planner] → [context-cap].

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 A token_budget config block exists, validates, and ships research-backed defaults in defaults/pipeline.yaml (max_context_pct=50, fan_out_width.green=2)
- [ ] #2 Node model selection skips models whose context window cannot hold the estimated node context within the cap; over-budget nodes fail fast with an evidence message (no silent truncation)
- [ ] #3 The scheduler enforces per-category fan-out caps; the planner prompt is token-aware
- [ ] #4 The orchestrate skill carries a 'Task sizing & token budget' section, distributed via oisin-ee/skills and verified by a scratch install
- [ ] #5 Full vitest suite, tsc --noEmit, and the ultracite + fallow gates are green
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Token-aware sizing & budgeting shipped in @oisincoveney/pipeline 2.4.0. Live-verified on the published global moka: validate/explain-plan/doctor/init/run all pass with the token_budget config; a real `moka run --schedule` triggered the hard per-node context cap (estimated 308148 tokens > 50% of the 200k window → openai/gpt-5.5 skipped, node failed fast, no dispatch); `moka init` distributes the updated orchestrate skill. Fan-out caps + planner awareness + size-aware routing covered by the CI-gated test suite. Remaining for a future demo: live multi-agent green fan-out (≤2 concurrent) and a token-efficiency-vs-uncapped measurement, both expensive (multiple real agent runs).

<!-- SECTION:FINAL_SUMMARY:END -->
