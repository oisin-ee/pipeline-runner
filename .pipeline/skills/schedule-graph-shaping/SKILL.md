---
name: schedule-graph-shaping
description: Use when generating or reviewing pipeline schedule graphs for a task or epic. Shapes explicit root DAGs by grouping related tickets and verification work by goal, dependency, and evidence instead of defaulting to one full RED/GREEN/VERIFY chain per ticket.
---

# Schedule Graph Shaping

Use this when producing a `pipeline-schedule` YAML artifact.

## Contract

- Return only the artifact requested by the schedule planner. Do not add prose.
- Generate exactly one workflow named `root`.
- Do not use `kind: workflow` or embed configured workflow copies such as `default`, `infra`, `track`, or `epic-drain`.
- Every generated agent node must declare a configured `profile`.
- Node IDs must be stable lowercase kebab-case and match `^[a-z][a-z0-9-]*$`.
- Do not invent profiles, node-level skills, or unconfigured gates.
- Team-mode collaboration must be explicit DAG structure: lead/planner, parallel specialists, integration or drain-merge, acceptance reviewer, and verifier. Do not rely on hidden dynamic team state.
- Parallel write-capable specialists must either use isolated workflow worktree roots or fan in through an explicit drain-merge integration node before shared coverage.

## Shaping Procedure

1. Cluster work units by intent before drawing nodes.
   Group tickets that validate the same behavior, touch the same subsystem, share acceptance evidence, or must land in a fixed order.

2. Use RED nodes for test strategy, not ticket counting.
   One RED node can cover several GREEN tickets when they share the same failing test suite or behavior contract. Split RED nodes only when the tests are meaningfully independent or different profiles are needed.

3. Use GREEN nodes for independently implementable slices.
   A GREEN node may cover one ticket or a coherent group of tickets. Split GREEN nodes when the work can run in parallel, has different dependencies, has materially different ownership/risk, or would make one node too broad to review.

4. Add integration when parallel writers need it.
   Use a drain-merge node when multiple write-capable specialist nodes share the same repository worktree. Use isolated workflow worktree roots only when the generated schedule actually declares those roots.

5. Use acceptance nodes for user-visible outcomes.
   One acceptance node can cover multiple implementation nodes when they produce the same visible outcome or acceptance checklist.

6. Use verifier nodes for shared evidence.
   One verifier can validate multiple tickets when the same real repository commands and checks prove them. Split verifiers only when evidence differs, one area needs specialized inspection, or a dependency boundary requires earlier proof.

7. Preserve necessary serial order.
   Dependencies from the backlog, shared migrations/schema changes, public API changes, and foundational refactors should gate downstream implementation. Independent clusters should fan out and then fan in to shared acceptance, verifier, merge, or review nodes.

## Task Context

- Assign every backlog work unit to at least one explicit generated agent node with `task_context.id`.
- Prefer assigning ticket-specific context to GREEN nodes.
- RED, acceptance, and verifier nodes may omit `task_context` when they cover a group; include it only when the node is genuinely ticket-specific.

## Efficiency Checks

Before returning the graph, ask:

- Did I create a RED/GREEN/VERIFY chain just because a ticket exists?
- Can several GREEN nodes share one RED node without losing test-first behavior?
- Can several GREEN nodes share one verifier because the same commands prove them?
- Are independent implementation slices parallelized?
- Are serial edges based on real dependencies rather than habit?
