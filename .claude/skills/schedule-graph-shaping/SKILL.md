---
name: schedule-graph-shaping
description: Use when generating or reviewing pipeline schedule graphs and shaping DAGs for Moka workflows.
---

# Schedule Graph Shaping

Use this skill to shape Moka schedules as explicit DAGs instead of blindly expanding every ticket into an isolated full chain.

## Guidance

- Preserve ticket dependencies and acceptance evidence in the graph.
- Group related implementation, verification, and documentation nodes by deliverable.
- Prefer parallel nodes only when dependencies and shared file ownership allow safe concurrency.
- Keep gates explicit and downstream of the work they verify.
- Make reruns deterministic by naming nodes after stable work units, not transient agent attempts.

## The gates are load-bearing, not decorative

This skill shapes the graph that drains [[scope]]'s tickets, so it carries their binding contract into the DAG — the graph is where "partial ≠ done" becomes structural:

- **Every implementation node has a verification gate downstream of it that encodes the ticket's Definition of Done.** A deliverable is not "complete" in the graph until its gate node passes on real evidence ([[verify]]). A graph with implementation nodes and no verifying gates has scheduled the exact silent-partial failure the rest of the chain exists to prevent.
- **Gates do not get pruned to make the graph look parallel.** Dropping or merging a gate to flatten the DAG removes the evidence requirement, not just a node. If two nodes can't run in parallel without skipping a gate, they aren't parallel — sequence them.
- **A gate must be reachable and falsifiable.** A "verification" node that can't actually fail (no command, no criterion, no evidence) is theatre — it satisfies the graph's shape while proving nothing. Name what it checks and what output proves it.
