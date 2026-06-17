---
id: PIPE-85
title: >-
  changed-files gate must exclude .pipeline/ run-state from the allow-list
  comparison
status: To Do
assignee: []
created_date: '2026-06-17 14:26'
labels: []
dependencies: []
references:
  - 'src/gates.ts:337'
  - 'src/runtime/gates/gates.ts:632'
  - 'src/run-control/store.ts:112'
  - 'src/context/repo-map.ts:78'
  - backlog/docs/doc-1
modified_files:
  - src/runtime/gates/gates.ts
  - src/runtime/gates/gates.test.ts
  - tests/dogfood-installed.test.ts
priority: high
ordinal: 242000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Root cause of the failed moka run run-4a0f183d-2776-4828-a86b-4b89e969c6cd (see backlog doc-1). The changed_files gate compares worktree changes to each node's allow list, but the supervisor writes its OWN run-state into the worktree (.pipeline/runs/<id>/…, .pipeline/journal/…, runtime-events.jsonl, status.json, nodes/<node>/stdout.jsonl) WHILE nodes run. Those writes are on no node's allow list, so every write-mode node fails the gate with 'changed-file policy failed'. The gate already ignores SOME .pipeline paths (src/gates.ts:337-338: **/.pipeline/host-resources/**, **/.pipeline/skills/**) but NOT the run-state dirs the run-control store writes (src/run-control/store.ts:112 RUNS_DIRECTORY='.pipeline/runs'; journal via src/runtime/run-journal.ts). Result: deterministic failure of any thorough write-mode multi-node run in a repo whose .pipeline lives in the worktree. The TOVA-767 run died at the red phase; no green node ran.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 changed_files gate excludes supervisor run-state paths before deny/allow/require_any evaluation: .pipeline/runs/**, .pipeline/journal/**, .pipeline/runtime-events.jsonl, and .pipeline/**/status.json are never reported as 'changes outside allow list'; evidence: a focused runtime gate unit test fails before the fix and passes after.
- [ ] #2 Real node-authored source changes are still gated: a file outside the node allow list, such as README.md under allow ["src/**"], still fails with reason 'changed-file policy failed'; evidence: existing or added runtime gate test asserts the failure and evidence text.
- [ ] #3 The exclusion is scoped to pipeline-owned state, not a broad bypass for arbitrary dotfiles or source output; evidence: code review shows filtering is limited to a named helper/policy and no allow-list comparison branch is skipped wholesale.
- [ ] #4 Real repository usage is verified: a write-mode moka run in a fixture or dogfood repo whose .pipeline/runs lives in the worktree reaches at least one green-* node without any changed-files gate evidence mentioning .pipeline/runs or .pipeline/journal; evidence: command, run id, and relevant log excerpt are recorded in the task notes or final summary.
- [ ] #5 No partial completion: if the real moka run cannot be executed, the task remains open and the final summary states which unit tests passed and why the real-usage verification is blocked.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] Unit regression covers both excluded .pipeline run-state and still-disallowed real source changes.
- [ ] Real moka write-mode path is exercised, or the blocker is explicitly recorded without claiming the incident is fixed.
- [ ] No unsafe casts, disabled checks, catch-all workarounds, or changed-files gate bypasses are introduced.
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
HANDOFF PROMPT (oisin-pipeline):
Fix the changed_files gate so the supervisor's own run-state is never counted as node-authored changes.
1. Work in src/runtime/gates/gates.ts at evaluateChangedFilesGate, not the jscpd ignore list in src/gates.ts. The incident path is the runtime changed_files gate: it reads context.nodeStateStore.changedFiles(nodeId), then evaluates deny, allow, and require_any.
2. Add a small named helper/policy for supervisor-owned changed-file entries. It must filter .pipeline/runs/**, .pipeline/journal/**, .pipeline/runtime-events.jsonl, and .pipeline/**/status.json before deny/allow/require_any. Prefer narrow run-state filtering over ignoring all .pipeline/** unless code review shows generated skills/host resources also reach this runtime snapshot path.
3. Add/extend tests in src/runtime/gates/gates.test.ts. Include one changed snapshot with both .pipeline run-state and a legitimate disallowed source file so the test proves the filter does not hide real output. Include require_any coverage so excluded run-state does not satisfy required source/test changes.
4. Run focused tests first: bun test src/runtime/gates/gates.test.ts. Then run the repo's real relevant checks for this slice. Per repository verification standard, finish with a real moka write-mode command in a fixture or dogfood repo where .pipeline/runs is inside the worktree and capture the run id/log evidence.
5. Do not mark partial. Either the changed-files gate excludes run-state with unit evidence and real moka evidence, or escalate with the exact blocker.
<!-- SECTION:PLAN:END -->
