---
id: PIPE-90.5
title: 'Spec: criteria read-only ownership boundary'
status: Done
assignee: []
created_date: '2026-06-26 14:26'
updated_date: '2026-06-26 15:25'
labels: []
dependencies: []
references:
  - docs/moka-orchestrator-design.md
parent_task_id: PIPE-90
priority: medium
ordinal: 266000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: plan-scope-spec
Scope: locate and specify the enforcement seam making a ticket's acceptance criteria + their adjudicating tests READ-ONLY to the node's executing agent (anti reward-hacking; the agent must not weaken the tests that gate it). Inspect the agent FS sandbox/profile config and where criteria/tests live; produce assumptions + AC for a follow-up security ticket. No edits.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Enforcement seam identified with file:line (where agent FS access to criteria/tests is configured) -- Evidence: written findings citing the sandbox/profile code path
- [ ] #2 Follow-up security ticket drafted with concrete AC for read-only enforcement -- Evidence: ticket text with abuse-path test criteria
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Confirmed file:line citations (post-commit 45e4e53, verified 2026-06-26):

1. filesystem.allow/deny dead config: src/config/schemas.ts:288-294 — CONFIRMED exact lines unchanged. filesystemSchema declares .allow and .deny but grep of entire src/ confirms zero reads of actor.filesystem.allow or actor.filesystem.deny at runtime. Only filesystem.mode is consumed (src/config/validate.ts:334-335, src/install-commands/opencode.ts:220, src/pipeline-runtime.ts:1310, src/schedule/scheduling-roles.ts:67, src/schedule/prompts.ts:181). The policy.allow/deny in src/runtime/gates/gates.ts:652-660 refers to gate changed_files policy globs, not the profile filesystem fields — separate concern.

2. opencodePermission / external_directory deny: src/install-commands/opencode.ts:323-335 — CONFIRMED exact lines unchanged. external_directory:deny blocks paths outside the worktree; no intra-worktree path protection exists.

3. CLI runner --dangerously-skip-permissions: src/runner.ts:222 and 236 — CONFIRMED exact lines unchanged. Both branches of the ternary emit the flag unconditionally.

4. Acceptance criteria read from worktree: src/tickets/backlog-task-store.ts:100 — CONFIRMED exact line unchanged. join(worktreePath, 'backlog', 'tasks') is the path; criteria extracted at line 184 via extractAcceptanceCriteria.

5. Acceptance gate reads criteria: src/runtime/gates/gates.ts:513-523 (evaluateAcceptanceGate). Cited as ~520-522; actual range is 513-523 (function starts at 513, effectiveTaskContext call at 521-522). Minor line-number drift: spec cited 520-522, actual function is 513-523. Substance unchanged.

All citations valid post-45e4e53. No code edits made.
<!-- SECTION:NOTES:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the plan-scope-spec workflow in order (inspect -> assumptions -> AC -> grill/doubt review)
- [ ] #2 No code edits; findings + draft ticket recorded
<!-- DOD:END -->
