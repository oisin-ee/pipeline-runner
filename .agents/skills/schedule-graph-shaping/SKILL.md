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
