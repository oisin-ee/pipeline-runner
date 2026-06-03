---
id: PIPE-31.1
title: 'Runtime: kind: workflow node (sub-workflow invocation, no worktree)'
status: Done
assignee: []
created_date: '2026-05-28 17:41'
updated_date: '2026-05-28 18:31'
labels:
  - drain
  - runtime
milestone: m-0
dependencies: []
references:
  - /Users/oisin/.codex/plans/right-now-we-have-parallel-abelson.md
  - 'src/config.ts:423'
  - 'src/pipeline-runtime.ts:1190'
  - 'src/pipeline-runtime.ts:1199'
modified_files:
  - src/config.ts
  - src/workflow-planner.ts
  - src/pipeline-runtime.ts
  - tests/config.test.ts
  - tests/pipeline-runtime.test.ts
parent_task_id: PIPE-31
priority: high
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## What

Introduce a new workflow node kind that invokes a named sub-workflow defined elsewhere in the same `pipeline.yaml`. Sub-workflow execution reuses the existing `runPipelineFromConfig` machinery — same executor, hooks, gates, retry policy, reporter. The sub-workflow runs in the parent's `worktreePath` for now (no isolation). Worktree isolation is added in a follow-up task.

## Why

This is half of the structural-DAG primitive set the epic depends on. With it, a workflow becomes a composable building block: any workflow can invoke another workflow as a node, enabling reuse (`default` becomes a track sub-workflow inside `epic-drain`) and forming the basis for nested-DAG composition.

## YAML shape

```yaml
- id: frontend
  kind: workflow
  workflow: default            # name of another workflow defined in this config
```

## Schema (src/config.ts, around `workflowNodeSchema` at :423)

Add a new discriminant to `workflowNodeSchema`:

```ts
workflowNodeBaseSchema
  .extend({
    kind: z.literal("workflow"),
    workflow: z.string(),       // sub-workflow id; must exist in workflows registry
  })
  .strict()
```

Cross-reference validation lives where other workflow refs are checked (`validateRegistryIds` etc. in src/config.ts).

## Runtime (src/pipeline-runtime.ts, `executeNodeAttempt` switch at :1190)

Replace the existing `group` stub (`:1199`) by introducing a new `case "workflow"` that calls a new helper `executeWorkflowNode(node, context, attempt)`:

1. Compile the named sub-workflow plan (same path `compileWorkflowPlan` already takes).
2. Invoke `runPipelineFromConfig` (or its internal equivalent that accepts an already-built context) with:
   - `workflowId: node.workflow`
   - `worktreePath: context.worktreePath` (parent's path; no isolation yet)
   - `taskContext: context.taskContext` (inherited)
   - `executor: context.executor` (so test injection still works at the leaves)
   - `reporter: context.reporter` (interleaved events; prefix sub-workflow node ids with the parent node id when emitting so streams remain readable)
3. Sub-workflow agents read upstream context via the existing `lastOutputByNode` and `renderAgentPrompt` path — they inherit whatever was set in the parent. Do NOT add a JSON-pointer / "from" field on `kind: workflow`.
4. Aggregate the child's `PipelineRuntimeResult` into the node's output: `{ workflowId, status, nodeResults }`.
5. Map child failure to a `NodeAttemptResult` with non-zero exit code so the existing retry/gate machinery treats it consistently.

## Tests (tests/pipeline-runtime.test.ts)

Use the existing `executor` injection pattern.

1. `kind: workflow runs the named sub-workflow with inherited context` — assert child agents receive parent's `lastOutputByNode` and `taskContext`.
2. `kind: workflow propagates child failure to the parent node` — child fails → parent's node result is `failed` with the right evidence.
3. `kind: workflow reuses the parent executor` (so test injection works transparently).
4. Schema validation (in tests/config.test.ts): a `kind: workflow` node with no `workflow` field is rejected; a `kind: workflow` pointing at a missing workflow id is rejected by cross-reference validation.

## Non-goals (covered by other tasks)

- Worktree isolation, `worktree_root`, base-SHA pinning — separate ticket.
- Parallel execution of multiple sub-workflows — separate ticket (`kind: parallel`).

## Reference

`/Users/oisin/.codex/plans/right-now-we-have-parallel-abelson.md` §"1. `kind: workflow`".
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `src/config.ts` workflowNodeSchema accepts `kind: workflow` with required `workflow:` field; rejects unknown workflow id at cross-reference validation
- [x] #2 `src/pipeline-runtime.ts` dispatches `kind: workflow` through a new `executeWorkflowNode` helper that reuses `runPipelineFromConfig` (same executor, hooks, gates, retry, reporter)
- [x] #3 Sub-workflow inherits parent's `lastOutputByNode` and `taskContext` — child agents can reason about upstream node outputs via the existing prompt-rendering path
- [x] #4 Reporter events from a child sub-workflow stream through with enough context to identify the parent node
- [x] #5 Tests added: child runs with inherited context, child failure propagates, executor injection still works in nested runs
- [x] #6 Tests added: schema rejects missing `workflow:` field and unknown workflow id
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented same-worktree kind: workflow nodes through the configured pipe workflow. Added schema/cross-reference validation, planner metadata, runtime child workflow execution with inherited task context/upstream outputs, parent-context reporter events, failure propagation, and focused config/runtime tests. Verification passed: typecheck, full tests, Semgrep, duplication gate, acceptance, verifier, and learn nodes.
<!-- SECTION:FINAL_SUMMARY:END -->
