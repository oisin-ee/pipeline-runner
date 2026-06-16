---
id: PIPE-83.14
title: Make best_of_n schedules validator-valid so it can be a safe default
status: In Progress
assignee: []
created_date: '2026-06-16 10:53'
updated_date: '2026-06-16 12:44'
labels:
  - architecture
  - runtime
  - best-of-n
dependencies: []
references:
  - src/schedule/passes/candidates.ts
  - src/planning/generate.ts
  - src/runtime/select-candidate/select-candidate.ts
  - defaults/pipeline.yaml
parent_task_id: PIPE-83
priority: medium
ordinal: 232000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
best_of_n (PIPE-83.7/83.9) is implemented + threaded + usable when explicitly enabled, but it is NOT on by default because the candidates pass (src/schedule/passes/candidates.ts expandBestOfNCandidates) emits a schedule that the generate.ts validator rejects on real (esp. epic/work-unit) schedules. Enabling it in defaults/pipeline.yaml broke tests/dogfood-installed.test.ts (epic schedule validation). The structural gaps:

1. ALLOWED BUILTIN: `select-candidate` is not in SCHEDULE_BUILTINS (src/planning/generate.ts:39) → "unsupported generated builtin 'select-candidate'". Trivial: add it.

2. WORKTREE ISOLATION: unsafeParallelWorktreeIssues only treats a downstream drain-merge as satisfying isolation (hasDownstreamDrainMerge, generate.ts:618). The candidates parallel feeds a select-candidate, not drain-merge → "parallel node has write-capable children sharing a worktree without isolated worktree roots or drain-merge integration". Fix: treat select-candidate as a valid merge sink (it reads the candidate children and picks one), i.e. accept builtin in {drain-merge, select-candidate}.

3. COVERAGE REACHABILITY: candidate children (`<id>--c1/--c2`) are created with `needs: []` and nothing needs them by id (the parallel wraps them; select-candidate needs the parallel), so they are graph-islands — hasReachableDependent(child) reaches no coverage node → "implementation node '<child>' is without downstream verification or review". Fix: connect the children into the dependency graph (e.g. children keep the node's upstream needs; or the reachability model treats a parallel child's outputs as flowing to the parallel's dependents) AND/OR treat select-candidate as a coverage sink for its candidates.

4. WORK-UNIT DEPENDENCY EDGES: workUnitDependencyIssues (generate.ts:723) requires each implementation node assigned to work-unit W to have a reachable path from a prerequisite work-unit's nodes. Candidate children carry the original task_context.id (they spread ...node) but have needs:[] so the cross-work-unit edge is broken; the select-candidate node carries NO task_context. Fix: propagate task_context to select-candidate and ensure the candidate children inherit the upstream prerequisite edge so prerequisite-unit → dependent-unit candidate paths exist.

Also verify the runtime: executeSelectCandidateBuiltin (src/runtime/select-candidate/select-candidate.ts) reads the parallel children — confirm any needs/structure change keeps the selector reading the right candidate set, and that parallel_worktrees isolation still applies. Then turn best_of_n + parallel_worktrees ON in defaults/pipeline.yaml (n:2, categories:[green]) and regenerate any schedule goldens, explaining the diffs. Note the cost tradeoff (n=2 ~doubles green-node spend) in the YAML comment and docs/config-architecture.md.

GATE: tests/dogfood-installed.test.ts epic-schedule validation must pass with best_of_n enabled; full suite green; fallow/ultracite/tsc clean; no suppressions.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 select-candidate is an allowed generated builtin and recognized as a merge sink (worktree isolation) and coverage sink
- [x] #2 Candidate children are connected in the dependency graph so coverage + work-unit prerequisite edges validate (no graph-island children)
- [x] #3 select-candidate carries the original node task_context so work-unit assignment/edges resolve
- [ ] #4 best_of_n + parallel_worktrees enabled in defaults/pipeline.yaml (n:2, green); dogfood epic-schedule validation passes; full suite green; schedule goldens regenerated + explained
- [x] #5 Cost tradeoff (n>1 multiplies green-node spend) documented in defaults/pipeline.yaml + docs/config-architecture.md
- [ ] #6 RUNTIME GAP 1 (blocker, found via live run): candidate agents exit 70 (EXIT_INFRA) — the leased opencode server (rooted at main worktree) throws 'Unexpected server error' for a session with directory=<child worktree>. Fix: lease a per-worktree opencode server per candidate (runInLease in parallel-node.ts).
- [ ] #7 RUNTIME GAP 2 (blocker): the winning candidate's file changes stay in its worktree and are never merged back to main, so downstream nodes can't see them. Fix: promote the selected candidate's worktree diff on selection.
- [ ] #8 best_of_n + parallel_worktrees reverted to OFF in defaults until gaps 1+2 land (on-by-default hung every real run in a candidate retry loop). Re-enable + verify a full moka run completes PASS with candidates run + winner selected + merged.
<!-- AC:END -->
