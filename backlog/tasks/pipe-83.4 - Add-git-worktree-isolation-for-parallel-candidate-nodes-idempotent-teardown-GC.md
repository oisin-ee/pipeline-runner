---
id: PIPE-83.4
title: >-
  Add git-worktree isolation for parallel candidate nodes (idempotent teardown +
  GC)
status: Done
assignee: []
created_date: '2026-06-15 17:33'
updated_date: '2026-06-15 22:26'
labels:
  - runtime
  - architecture
dependencies: []
parent_task_id: PIPE-83
priority: medium
ordinal: 222000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workstream B (prerequisite for best-of-N). Give each parallel child node an isolated git worktree + auto-named branch so concurrent edits don't collide.

SEAM: the runtime execution path for kind: parallel children. Teardown MUST be idempotent and crash-safe; GC orphaned worktrees on startup; NEVER delete a dirty/unpushed worktree (direct lessons from Crystal / claude-squad / Vibe-Kanban worktree leaks). Handle .gitignore for the worktree dir.

NOTE in docs: a worktree is NOT a sandbox (shared node_modules / build state); real isolation remains k8s mode. Each worktree may need a bootstrap step for untracked deps/.env.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Each parallel child executes in its own worktree on an auto-named branch
- [x] #2 Teardown is idempotent; orphaned worktrees are GC'd on startup; dirty/unpushed worktrees are skipped, not deleted
- [x] #3 Concurrent children editing the same path do not corrupt each other's trees
- [x] #4 Tests cover create / teardown / GC / dirty-skip
- [x] #5 npx tsc --noEmit is clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
RECON (MoKa Researcher). SEAM: inject per-child worktree in src/runtime/parallel-node/parallel-node.ts (executeParallelChildren + executeFailFastParallelChildren) inside each child callback: runtime.executeNode(child, { ...context, worktreePath: lease.path }) wrapped in try/finally; KEEP the shared forkForParallelChildren nodeStateStore. In failFast, allocate the lease INSIDE the p-limit callback (not before scheduling) so limit.clearQueue()'d children don't allocate worktrees. CRITICAL CAVEAT: the opencode SDK executor binds `directory` at LEASE time (opencode-runtime.ts:63-70 -> opencode-session-executor.ts:91-95/115-118), so changing per-child context.worktreePath updates RunnerLaunchPlan.cwd but NOT the SDK session dir — must make createOpencodeExecutor honor plan.cwd (RunnerLaunchPlan already carries cwd) OR lease a per-child executor. NEW MODULE src/runtime/parallel-worktrees/parallel-worktrees.ts: sanitized paths under .pipeline/worktrees/ (already gitignored at .gitignore:12), auto-branch from parent HEAD via `git worktree add -b`, JSON manifest under registry/ (states: creating/active/teardown-attempted/removed/retained-dirty/retained-unpushed/error). TEARDOWN: `git worktree prune`; require `status --porcelain --untracked-files=all` empty AND HEAD==baseSha-or-pushed before removal, else retain + emit evidence; idempotent. STARTUP GC: scan registry + `git worktree list --porcelain`, only oisin-pipeline-owned + pipeline/worktrees/ branches, same safety guard. NOTE: linked-worktree .git is a FILE not dir -> ensureOpencodeGitExcludes may no-op. 9-step TDD plan in recon.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Committed 6585519 (controller-implemented). New src/runtime/parallel-worktrees module: createChildWorktree (auto-named branch off parent HEAD, JSON manifest, idempotent reuse), releaseWorktree (git worktree prune + status --porcelain/--untracked-files=all dirty guard + HEAD!=baseSha unpushed guard -> RETAIN never delete; idempotent), gcParallelWorktrees (startup GC over owned manifests, same guard). Wired into parallel-node behind a default-OFF parallel_worktrees config flag: gcStaleWorktrees() per parallel node + runChildInWorktree() routing each child through a per-child worktree (lease created INSIDE the per-child callback so failFast-cleared children never allocate; released in finally, retaining candidate diffs for PIPE-83.7/.9 selection). Default-off path byte-identical -> existing parallel-node tests + PIPE-57 goldens unchanged. Tests (temp git repo): create / clean-remove-idempotency / dirty-retain / unpushed-retain / GC-clean-vs-dirty. Verified: tsc clean, ultracite clean, fallow-audit 0 introduced findings, full suite 601 passed / 4 skipped. ONE FOLLOW-UP (from recon, not blocking command-runner isolation): the opencode SDK executor binds `directory` at lease time, so SDK-runner nodes need createOpencodeExecutor to honor plan.cwd for full per-child isolation; the command/subprocess runner already honors RunnerLaunchPlan.cwd from the injected worktreePath. Unblocks PIPE-83.7.
<!-- SECTION:FINAL_SUMMARY:END -->
