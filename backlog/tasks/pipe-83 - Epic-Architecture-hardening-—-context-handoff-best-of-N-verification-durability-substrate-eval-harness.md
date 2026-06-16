---
id: PIPE-83
title: >-
  Epic: Architecture hardening — context handoff, best-of-N verification,
  durability substrate, eval harness
status: To Do
assignee: []
created_date: '2026-06-15 17:32'
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
