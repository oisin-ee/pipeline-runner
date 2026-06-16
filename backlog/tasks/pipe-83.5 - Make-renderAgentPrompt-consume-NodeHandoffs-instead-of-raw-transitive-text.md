---
id: PIPE-83.5
title: Make renderAgentPrompt consume NodeHandoffs instead of raw transitive text
status: To Do
assignee: []
created_date: '2026-06-15 17:34'
updated_date: '2026-06-15 19:17'
labels:
  - architecture
  - context-engineering
dependencies:
  - PIPE-83.1
  - PIPE-83.2
references:
  - src/runtime/agent-node/agent-node.ts
parent_task_id: PIPE-83
priority: high
ordinal: 223000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workstream A — the core fix for the latency/quality leak.

SEAM: src/runtime/agent-node/agent-node.ts renderAgentPrompt(). Today it concatenates node.needs.map(need => nodeStateStore.outputText(need)) PLUS transitive inherited outputs — i.e. raw re-hydration of all upstream text into every prompt, every attempt (this is Roo #3362 in shipped form). Replace with: (a) typed NodeHandoff objects from immediate needs (PIPE-83.1), and (b) repo-map-selected code context (PIPE-83.2). Down = curated instructions + handoffs; raw transcript stays in the child (the Roo/Kilo envelope done right).

Regenerate PIPE-57 goldens and explain the diffs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 renderAgentPrompt no longer concatenates verbatim output of non-adjacent ancestor nodes
- [ ] #2 Immediate needs are passed as NodeHandoff structure; a test asserts node N's prompt excludes node N-2's raw output
- [ ] #3 Estimated token count for a representative deep chain drops measurably versus baseline (asserted)
- [ ] #4 PIPE-57 goldens regenerated, diffs explained, and green
- [ ] #5 npx tsc --noEmit is clean
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
CORE LANDED (commit 8e3306b, controller-implemented after the opencode Test Writer lane stalled on WASM-fixture setup). renderAgentPrompt now renders each dependency's curated NodeHandoff (new renderDependencySection helper, used by BOTH the direct-needs map and inheritedOutputSections) instead of dumping raw transcripts; renderHandoff re-added to handoff.ts (data-driven, cyclomatic 4 to stay under the audit gate). Falls back to raw outputText when no handoff -> flag-OFF behaviour byte-identical, PIPE-57 goldens unchanged (no regen needed). Tests: renderHandoff unit test + inheritedOutputSections-with-handoff test proving the summary replaces the raw transcript. Verified: tsc clean, ultracite clean, fallow-audit 0 introduced findings, full suite 596 passed / 4 skipped. REMAINING (blocked on PIPE-83.2): inject repo-map code-context selection + make renderAgentPrompt async to await buildRepoMapContext. The raw-text re-hydration kill (the main PIPE-83 win) is DONE; repo-map is an enhancement layered on next.
<!-- SECTION:NOTES:END -->
