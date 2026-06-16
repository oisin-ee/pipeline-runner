---
id: PIPE-83
title: >-
  Epic: Architecture hardening — context handoff, best-of-N verification,
  durability substrate, eval harness
status: Done
assignee: []
created_date: '2026-06-15 17:32'
updated_date: '2026-06-16 10:35'
labels:
  - architecture
  - token-engineering
  - runtime
dependencies: []
priority: high
ordinal: 218000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Outcome of the 2026-06-15 deep-research review (see memory: project_architecture_verdict). Verdict: KEEP moka's declarative DAG + scheduler + token-aware multi-model selection + per-category fan-out caps + MCP gateway + k8s (no competitor has this combination), but (a) topology is NOT the quality lever, and (b) the real latency/quality leak is raw-text re-hydration between nodes.

Four workstreams, sequenced A → (D in parallel) → B → C:

A. Structured context handoff — replace raw transitive-text dumping in agent-node with typed, selected, condensed handoffs. Keystone. Steals: Aider repo-map (PageRank + token-budget), OpenHands condenser, RA.Aid typed memory, Roo/Kilo curated envelope.
B. Best-of-N verifier — the ONE multi-agent pattern with measured quality gains (CodeMonkeys +11.6pp, R2E-Gym hybrid verifier +16.6pp). Selection over candidates, hybrid (tests + LLM judge), no silent self-fix.
C. Durability/concurrency substrate — close the resume-after-crash gap; spike DBOS vs Restate vs Effect; keep graphlib compiler + selectNodeModel.
D. Single-agent A/B eval harness — flat baseline + fixed task set + ablations to PROVE which components earn their keep. Run early as the go/no-go gate.

Config-first: only A's primitives (handoff schema, repo-map, condenser) and C's substrate are new TS; B and D are largely pipeline.yaml. Regression gate: PIPE-57 goldens green after every phase. Cost discipline per cost-aware-models memory.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
All 13 subtasks Done and pushed to origin/main, each behind the full pre-commit gate (ultracite + fallow-audit + tsc), full suite 634 passing, zero lint/dead-code suppressions. Delivered: 83.1 NodeHandoff envelope; 83.2 repo-map code-context selection (web-tree-sitter + graphology PageRank); 83.5 renderAgentPrompt consumes curated handoffs instead of raw transitive transcripts (the core re-hydration-leak fix); 83.4 parallel worktrees; 83.7+83.9 best-of-N candidate generation + LLM-judge selection; 83.3+83.6 eval harness (moka bench); 83.8 Effect v3 PoC; 83.10 scheduler core now runs on Effect (forked fibers + completion Queue replacing the hand-rolled Promise.race; structured-concurrency cancellation) WITH opt-in durable crash-resume (RunJournal seam, resume from last passed node, no token re-spend); 83.11 mcp_gateway.host_scope=global stops per-project gateway synthesis; 83.12 moka init --skill-scope personal installs skills once at user scope; 83.13 spike. Every new feature is default-off, so PIPE-57 generation goldens are unchanged. Remaining follow-ups are out-of-band published-package verifications per the moka-verification rule (eval run records; fresh-repo real-init checks) and optional future layers on the seams already in place (an @effect/workflow/cluster durability provider; Schedule-based node retry) — none block the epic.
<!-- SECTION:FINAL_SUMMARY:END -->
