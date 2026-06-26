---
id: PIPE-90.12
title: Enforce read-only criteria + adjudicating-tests boundary for node agents
status: Done
assignee: []
created_date: '2026-06-26 15:13'
updated_date: '2026-06-26 16:46'
labels:
  - security
dependencies:
  - PIPE-90.5
references:
  - docs/moka-orchestrator-design.md
  - src/tickets/backlog-task-store.ts
modified_files:
  - src/install-commands/opencode.ts
  - src/runner.ts
  - src/config/schemas.ts
parent_task_id: PIPE-90
priority: high
ordinal: 273000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: security
Implements design principle #7 (docs/moka-orchestrator-design.md): a node's executing agent must NOT author or weaken (a) its ticket's acceptance criteria or (b) the tests that adjudicate it (anti reward-hacking; SWE-bench hides test patches).

Today there is NO enforcement (from PIPE-90.5 spec): profile filesystem.allow/deny (src/config/schemas.ts:288-294) is declared but never read (dead config); the only runtime FS boundary is per-tool permissions + external_directory:deny (src/install-commands/opencode.ts:323-335), which does not protect paths INSIDE the worktree; the CLI runner bypasses permissions via --dangerously-skip-permissions (src/runner.ts:222,236). Criteria live in backlog/tasks/*.md inside the writable worktree (src/tickets/backlog-task-store.ts:100); tests sit in the normal tree.

Define a ticket-owned protected-paths set (the ticket AC file + its adjudicating test files) and enforce read-only against the executing agent on BOTH transports: extend the opencode permission generator to emit per-path deny/ask rules, and close the CLI-runner bypass. Wire filesystem.deny (or a new task_context.protected_paths) through to the launch plan so it is consumed, not inert. Note: bash tool can defeat path perms via redirection -> intercept at FS layer or deny bash for impl profiles.
Escalation: report Met/Unmet with evidence per AC.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A node agent's write to its own ticket AC file (backlog/tasks/<ticket>.md AC block) is rejected/detected -- Evidence: edit/write under the node profile returns denied and file content unchanged
- [ ] #2 A node agent's write/deletion of an adjudicating test file in the protected set is rejected -- Evidence: edit, write, and bash rm/>> against a protected test path all blocked; file byte-identical after
- [ ] #3 Enforcement holds on the opencode transport -- Evidence: generated opencode permission map contains per-path deny entries; unit test asserts them
- [ ] #4 Enforcement holds on the CLI/runner transport -- Evidence: runner.ts no longer relies solely on --dangerously-skip-permissions for protected paths; CLI-routed write to protected path blocked in test
- [ ] #5 filesystem.deny / task_context.protected_paths is actually consumed -- Evidence: removing the protected entry re-enables the write in a test (proves live, not inert) + grep shows field read at runtime
- [ ] #6 Planner/scheduler and gate evaluators retain access -- Evidence: acceptance gate (gates.ts:520-522) still reads criteria and test gates still run with enforcement on
- [ ] #7 Bypass attempts covered -- Evidence: path-traversal (../), symlink, and bash-redirect attempts against the protected set all blocked
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run the security workflow with abuse-path tests as primary evidence
- [ ] #2 Both transports covered; no protected write succeeds in any test
- [ ] #3 Dead filesystem.allow/deny config is wired in or replaced by a live field
<!-- DOD:END -->
