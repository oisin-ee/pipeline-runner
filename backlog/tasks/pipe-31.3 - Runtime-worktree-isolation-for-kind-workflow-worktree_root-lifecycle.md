---
id: PIPE-31.3
title: 'Runtime: worktree isolation for kind: workflow (worktree_root + lifecycle)'
status: Done
assignee: []
created_date: '2026-05-28 17:43'
updated_date: '2026-05-28 19:25'
labels:
  - drain
  - runtime
milestone: m-0
dependencies:
  - PIPE-31.1
references:
  - /Users/oisin/.codex/plans/right-now-we-have-parallel-abelson.md
  - 'src/pipeline-runtime.ts:384'
  - 'src/pipeline-runtime.ts:1141'
modified_files:
  - src/config.ts
  - src/workflow-planner.ts
  - src/pipeline-runtime.ts
  - tests/config.test.ts
  - tests/workflow-planner.test.ts
  - tests/pipeline-runtime.test.ts
parent_task_id: PIPE-31
priority: high
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## What

Add `worktree_root` as an optional field on `kind: workflow` nodes. When set, the sub-workflow runs in a freshly-created git worktree at the resolved path on a fresh branch. The runtime owns the full lifecycle: create on entry, remove on success, leave for inspection on failure.

## Why

This is the isolation that makes parallel branches in a `kind: parallel` container safe to run concurrently — each sub-workflow writes to its own filesystem, so independent tickets can't silently clobber each other on shared files like `package.json` or `research.json`. Without this, running multiple sub-workflows under a `parallel` container has last-write-wins semantics (the current runtime is `parent worktreePath` shared; see `src/pipeline-runtime.ts:384`).

Conflict-frequency evidence in the source plan: hot files in this repo are `package.json` (28 commits/6mo), `src/index.ts` (24), `src/pipeline-runtime.ts` (22), plus `research.json` filename collision between any two parallel researchers. Worktrees are necessary for safe parallel execution.

## YAML shape

```yaml
- id: frontend
  kind: workflow
  workflow: default
  worktree_root: .pipeline/runs/${runId}/frontend
```

## Template substitution

Resolve `${runId}` and `${nodeId}` in `worktree_root` strings. No general templating engine — just these two variables.

- `${runId}`: pinned once at parent-workflow start. Source: timestamp + small random suffix to make it readable and unique (e.g. `20260528-174125-7a2b`). Store on the parent `RuntimeContext` and pass through to nested executions.
- `${nodeId}`: substituted to the node's id (here, `frontend`).

If `worktree_root` references `${runId}` and no parent run-id is set, generate one for this run (a top-level workflow with `kind: workflow` children using `worktree_root` is allowed).

## Lifecycle

1. **Before child dispatch**: pin `git rev-parse HEAD` once at parent-workflow start (cache on `RuntimeContext`). Use that SHA as base for every `kind: workflow` worktree under this run.
2. **Create**: `git worktree add -b <branchName> <resolvedWorktreeRoot> <baseSha>`. Branch name: `${runId}/${nodeId}` (slash-delimited; safe in git, easy to bulk-delete). Use `simple-git` (already a dep — see `pipeline-runtime.ts:1141`).
3. **Symlink `.pipeline/`**: if `.pipeline/` isn't visible in the new worktree (it normally is, but verify), symlink it from the parent worktree so workflow-level hooks like `generated-defaults-audit` still find their config files. One-shot per worktree.
4. **Dispatch**: invoke the sub-workflow with `worktreePath: resolvedWorktreeRoot`. Pass the resolved branch name in the child's `taskContext` so downstream nodes / drain-merge can reference it.
5. **On success**: `git worktree remove --force <resolvedWorktreeRoot>`. Leave the branch alone; downstream `drain-merge` will use it. (If no drain-merge follows, the branches accumulate — that's by design; the runId scoping keeps them organized.)
6. **On failure**: leave the worktree and branch intact. Emit an evidence line with the absolute path (`cd <path>` is enough for the user to inspect).

## Concurrency safety

`executeWorkflowNode` must NOT mutate `process.env` to communicate the per-child `worktreePath` (would race across `pLimit`). Pass it via the child's `PipelineRuntimeOptions` only.

## Output

Extend the `kind: workflow` node output (from the prior task) to include:

```ts
{
  workflowId,
  status,
  nodeResults,
  branch: "<branchName>" | null,      // null when no worktree_root
  worktreePath: "<resolvedPath>" | null,
  baseSha: "<pinnedSha>" | null,
}
```

`drain-merge` (separate ticket) reads these from the `parallel` container's child outputs.

## Tests (tests/pipeline-runtime.test.ts)

Mock `simple-git` / `execa` for git worktree commands; assert call shapes.

1. `kind: workflow with worktree_root creates a worktree on a new branch from the pinned base SHA` — verify `git rev-parse HEAD` invoked once at parent start, `git worktree add -b <runId>/<nodeId> <path> <baseSha>` invoked with the resolved path.
2. `kind: workflow with worktree_root removes the worktree on success`.
3. `kind: workflow with worktree_root leaves the worktree on failure` — verify no `git worktree remove` call; verify failure evidence includes the absolute path.
4. `kind: workflow with worktree_root resolves ${runId} and ${nodeId} substitutions`.
5. `kind: workflow without worktree_root reuses the parent's worktreePath` — no `git worktree add` call.
6. `concurrent kind: workflow children get independent worktreePaths` — env not mutated; each child's `PipelineRuntimeOptions.worktreePath` is its own.
7. `parent-workflow-start pins base SHA once across multiple kind: workflow children`.

## Dependencies

Depends on PIPE-31.1 (`kind: workflow` primitive) — extends it.

## Reference

`/Users/oisin/.codex/plans/right-now-we-have-parallel-abelson.md` §"1. `kind: workflow`" (the `worktree_root` clause) and §"Open items resolved during implementation" (base SHA pinning, env safety, `.pipeline/` symlink).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Schema accepts optional `worktree_root: string` on `kind: workflow` nodes
- [x] #2 `${runId}` and `${nodeId}` substitution implemented; no general templating engine
- [x] #3 Base SHA pinned once per parent workflow at start via `git rev-parse HEAD` and reused for every nested worktree under that run
- [x] #4 `git worktree add -b ${runId}/${nodeId} <path> <baseSha>` runs before child dispatch
- [x] #5 Child runs with `worktreePath` set to the resolved path; `.pipeline/` symlinked into the new worktree if not already visible
- [x] #6 Worktree removed via `git worktree remove --force` on child success; left intact on failure with absolute path emitted in evidence
- [x] #7 No `process.env` mutation — per-child paths passed via `PipelineRuntimeOptions` to avoid races across `pLimit`
- [x] #8 Node output includes `branch`, `worktreePath`, and `baseSha` (or null when `worktree_root` is absent) so downstream `drain-merge` can consume them
- [x] #9 Tests added covering: worktree create+remove on success, leave-on-failure, runId/nodeId substitution, no-op when `worktree_root` absent, concurrent children get independent paths, base SHA pinned once per parent run
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented workflow-node worktree isolation through the configured pipe workflow. Added optional worktree_root schema/planner support, runId generation, workflow-start base SHA pinning, git worktree add/remove --force lifecycle, .pipeline symlink fallback, child worktreePath dispatch without env mutation, failure inspection evidence, metadata output fields with null no-worktree values, and focused tests for success/failure/substitution/concurrency/base-SHA behavior. Verification passed: typecheck, full tests, Semgrep, duplication gate, acceptance, verifier, and learn nodes.
<!-- SECTION:FINAL_SUMMARY:END -->
