---
id: PIPE-31.4
title: 'Runtime: drain-merge builtin (topological merge of parallel-branch worktrees)'
status: Done
assignee: []
created_date: '2026-05-28 17:43'
updated_date: '2026-05-28 20:05'
labels:
  - drain
  - runtime
milestone: m-0
dependencies:
  - PIPE-31.2
  - PIPE-31.3
references:
  - /Users/oisin/.codex/plans/right-now-we-have-parallel-abelson.md
  - 'src/config.ts:54'
  - src/gates.ts
  - 'src/pipeline-runtime.ts:1141'
modified_files:
  - src/config.ts
  - src/pipeline-runtime.ts
  - tests/config.test.ts
  - tests/pipeline-runtime.test.ts
parent_task_id: PIPE-31
priority: high
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## What

Add a new project builtin `drain-merge` that reads the prior node's output (typically a `kind: parallel` container whose children are `kind: workflow` invocations with `worktree_root`), creates an integration branch from the pinned base SHA, and merges each PASSed child branch into it using `git merge --no-ff`. Conflicts are surfaced, not auto-resolved.

## Why

After parallel sub-workflows have produced isolated branches in separate worktrees, the user needs them reconciled. Without this builtin you'd write inline `command` nodes with shell scripts per use; the builtin makes the reconciliation a first-class, unit-testable step that pairs naturally with the `kind: parallel + kind: workflow + worktree_root` pattern.

## YAML usage

```yaml
- id: merge
  kind: builtin
  builtin: drain-merge
  needs: [implement]   # `implement` is a `kind: parallel` whose children produced branches
```

Lives next to the existing builtins (`typecheck`, `test`, `semgrep`, `duplication`). Registry update in `src/config.ts` (the `BUILTIN_GATES`/builtin-node registry). Executor in `src/gates.ts` (or wherever sibling builtin node executors live; verify).

## Execution

1. Read the prior node's output via `context.lastOutputByNode`. Expected shape: a `kind: parallel` container with `{ children: { <id>: { status, branch, worktreePath, baseSha, ... } } }`. If `baseSha` differs across children, error (something is wrong upstream).
2. Determine the integration branch name: `runs/integration/${runId}` (the same `${runId}` the worktree-isolation ticket pins on the parent context).
3. Determine the merge order: walk the children in their declaration order from the parent `parallel` node (sibling order; drain doesn't compute a separate topology here — the YAML order is the topology because `parallel` siblings are formally independent).
4. Switch (or check out) the integration branch starting from `baseSha`. Create it if it doesn't exist.
5. For each PASSed child branch:
   - `git merge --no-ff --no-edit <branch> -m "drain-merge: <id>"`
   - On conflict: capture `git diff --name-only --diff-filter=U`, run `git merge --abort`, record the conflict in the output report, continue to the next sibling.
6. Skip children that didn't PASS; record them as `skipped` in the report.
7. Output a `MergeReport` JSON:

```ts
{
  integrationBranch: string,
  baseSha: string,
  merged:    [ { id, branch } ],
  skipped:   [ { id, reason: "failed" | "no-worktree" } ],
  conflicts: [ { id, branch, files: string[] } ],
}
```

8. Exit code: non-zero iff any child PASSed but failed to merge. Successful merges with some skipped/non-PASSed children are still exit 0 — those failures already surfaced in the parent run, drain-merge's job is just integration.

## Use `simple-git`

Already a dependency (see `pipeline-runtime.ts:1141`). Reuse it for merge/abort/branch operations — same pattern as the worktree-isolation ticket.

## Tests (tests/gates.test.ts)

Mock `simple-git` / `execa`.

1. `drain-merge merges PASSed children in declaration order` — assert `git merge` calls in correct sequence with `--no-ff`.
2. `drain-merge captures conflicts and aborts the failed merge` — synthesize a conflict on one child, assert `git diff --name-only --diff-filter=U` invoked, assert `git merge --abort` invoked, assert subsequent siblings still attempted.
3. `drain-merge skips non-PASSed children` — child with `status: "failed"` is in `skipped` list, no merge attempted.
4. `drain-merge errors when child baseSha values diverge` — defensive check.
5. `drain-merge creates the integration branch from baseSha if missing`.
6. `MergeReport JSON shape matches the documented schema`.

## Dependencies

Depends on:
- PIPE-31.2 (`kind: parallel`) — drain-merge consumes its output shape.
- PIPE-31.3 (`worktree_root` lifecycle) — drain-merge expects `branch` + `baseSha` in child outputs.

## Reference

`/Users/oisin/.codex/plans/right-now-we-have-parallel-abelson.md` §"The one project builtin: `drain-merge`".
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `drain-merge` registered as a builtin node kind alongside `typecheck`/`test`/`semgrep`/`duplication` in `src/config.ts`
- [x] #2 Executor reads upstream `parallel` container's child outputs, expects `{ status, branch, worktreePath, baseSha }` per child
- [x] #3 Creates `runs/integration/${runId}` from pinned base SHA; idempotent if it already exists
- [x] #4 Walks PASSed children in declaration order; runs `git merge --no-ff --no-edit <branch>` per child
- [x] #5 On conflict: captures `git diff --name-only --diff-filter=U`, runs `git merge --abort`, records conflict, continues with siblings
- [x] #6 Skips non-PASSed children and records them in `skipped` with a reason
- [x] #7 Errors when child `baseSha` values diverge (defensive)
- [x] #8 Output is a `MergeReport` JSON with `integrationBranch`, `baseSha`, `merged[]`, `skipped[]`, `conflicts[]`
- [x] #9 Exit code non-zero iff any PASSed child failed to merge; per-child failures upstream do not by themselves fail drain-merge
- [x] #10 Tests added: merge in order, conflict capture+abort+continue, skip non-PASSed, baseSha divergence error, integration branch creation, report shape
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented the drain-merge builtin and verified it through the configured pipe workflow. The runtime now accepts drain-merge as a workflow builtin, reads parallel child worktree outputs, creates or checks out an integration branch, merges PASSed branches in declaration order, records skipped children and conflicts, rejects divergent base SHAs before side effects, and preserves strict failed-parallel behavior except for direct drain-merge continuation. Added focused runtime/config coverage including failed workflow child plus passing worktree child regression. Verification passed: typecheck, full tests, semgrep, duplication, acceptance PASS, verifier PASS.
<!-- SECTION:FINAL_SUMMARY:END -->
