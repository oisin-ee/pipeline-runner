---
id: PIPE-31.2
title: "Runtime: kind: parallel container node (concurrent children)"
status: Done
assignee: []
created_date: "2026-05-28 17:42"
updated_date: "2026-05-28 18:56"
labels:
  - drain
  - runtime
milestone: m-0
dependencies:
  - PIPE-31.1
references:
  - /Users/oisin/.codex/plans/right-now-we-have-parallel-abelson.md
  - "src/config.ts:423"
  - "src/pipeline-runtime.ts:1190"
  - "src/pipeline-runtime.ts:498"
modified_files:
  - src/config.ts
  - src/workflow-planner.ts
  - src/pipeline-runtime.ts
  - tests/config.test.ts
  - tests/pipeline-runtime.test.ts
parent_task_id: PIPE-31
priority: high
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

## What

Introduce a new workflow node kind whose `nodes:` children execute concurrently. Children can be any kind — `agent`, `command`, `builtin`, `workflow` (the new sub-workflow primitive), or even nested `parallel` containers. Uniform composition; no special-casing per child kind.

## Why

The other half of the structural-DAG primitive set. With `kind: parallel`, a YAML workflow expresses parallel execution structurally — readable at a glance — instead of via implicit batching from `needs:` declarations. Combined with `kind: workflow` it expresses "four parallel branches, each running a sub-workflow" cleanly.

## YAML shape

```yaml
- id: implement
  kind: parallel
  nodes:
    - { id: test, kind: workflow, workflow: default }
    - { id: frontend, kind: workflow, workflow: default }
    - { id: backend, kind: workflow, workflow: default }
    - { id: k8s, kind: workflow, workflow: infra }
```

## Schema (src/config.ts, `workflowNodeSchema` at :423)

Add a discriminant:

```ts
workflowNodeBaseSchema
  .extend({
    kind: z.literal("parallel"),
    nodes: z.array(workflowNodeSchema).min(1), // recursive — same shape as top-level
  })
  .strict();
```

Reject empty children at schema time (a lint will also surface this in `pipe validate` — separate ticket — but the schema is the first line of defense).

The recursive reference means the existing `workflowNodeSchema` declaration must be made lazy (`z.lazy(() => ...)`) to allow nesting.

## Runtime (src/pipeline-runtime.ts, `executeNodeAttempt` switch at :1190)

Add `case "parallel": return executeParallelNode(node, context, attempt)`. `executeParallelNode`:

1. Materialize each child as a `PlannedWorkflowNode` (reuse the same compilation logic the top-level workflow uses for its node list).
2. Run children using the existing `pLimit(context.maxParallelNodes)` strategy at `pipeline-runtime.ts:498`. No new concurrency machinery.
3. Each child's execution recurses through `executeNodeAttempt` — same dispatch, so children can be any kind.
4. Aggregate output: `{ children: { <childId>: <childOutput> } }`.
5. Failure semantics inherit the parent workflow's `execution.failFast` — if set, abort siblings; if not, all children run to completion and the parallel node reports `failed` iff any child failed.
6. Reporter: emit `node.start`/`node.success`/`node.error` for the container itself, plus the children's own events (already emitted by their recursive `executeNode` calls).

## Tests (tests/pipeline-runtime.test.ts)

1. `kind: parallel runs children concurrently and honors maxParallelNodes` — schedule three children with controlled executor delays; assert the observed overlap matches the limit.
2. `kind: parallel with failFast aborts pending siblings` — one child fails, siblings in flight are signaled, queue is drained.
3. `kind: parallel without failFast runs all siblings and reports aggregate failure` — one child fails, others complete, container result is `failed`.
4. `nested parallel + workflow composition works` — outer parallel containing inner parallel containing `kind: workflow` children; assert correct topology and aggregation.
5. Schema validation (tests/config.test.ts): empty `nodes:` rejected; deeply nested `parallel`/`workflow` shapes parse.

## Non-goals (covered by other tasks)

- Worktree isolation per child — owned by the `worktree_root` ticket (children gain isolation via `kind: workflow` with `worktree_root`, not via `kind: parallel`).
- `drain-merge` integration of child branches — separate ticket.

## Dependencies

Depends on PIPE-31.1 (`kind: workflow` primitive) landing first so the nested-composition test has a sub-workflow primitive to use.

## Reference

`/Users/oisin/.codex/plans/right-now-we-have-parallel-abelson.md` §"2. `kind: parallel`".

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 `src/config.ts` workflowNodeSchema accepts `kind: parallel` with non-empty `nodes:` children; schema declaration made lazy to support recursion
- [x] #2 Empty `nodes:` array rejected at schema validation
- [x] #3 `src/pipeline-runtime.ts` dispatches `kind: parallel` to `executeParallelNode` that runs children via existing `pLimit(maxParallelNodes)`
- [x] #4 Children may be any kind, including nested `parallel` or `workflow` — uniform composition verified by test
- [x] #5 Output shape is `{ children: { <id>: <childOutput> } }`
- [x] #6 Failure semantics inherit parent workflow's `execution.failFast` (test: failFast aborts pending siblings; non-failFast runs all and aggregates)
- [x] #7 Reporter emits container-level node events plus the children's own events
- [x] #8 Tests added: concurrency limit, failFast abort, aggregate-on-fail, nested composition with `kind: workflow`
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Implemented kind: parallel container nodes through the configured pipe workflow. Added recursive schema support, recursive child validation/planning, runtime child execution via existing pLimit strategy, maxParallelNodes handling, failFast abort and queue clearing, aggregate output JSON, nested parallel/workflow composition, reporter parent context, and focused tests. Verification passed: typecheck, full tests, Semgrep, duplication gate, acceptance, verifier, and learn nodes.

<!-- SECTION:FINAL_SUMMARY:END -->
