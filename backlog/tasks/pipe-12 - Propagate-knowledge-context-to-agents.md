---
id: PIPE-12
title: Propagate knowledge context to agents
status: Done
assignee:
  - Codex
created_date: '2026-05-21 09:19'
updated_date: '2026-05-21 09:46'
labels:
  - knowledge
  - agents
dependencies:
  - PIPE-10
references:
  - src/mastra/workflows/pipeline.ts
  - src/mastra/steps/knowledge-inject.ts
  - src/mastra/runner.ts
  - rules/
modified_files:
  - src/mastra/steps/knowledge-inject.ts
  - src/mastra/workflows/pipeline.ts
  - tests/pipeline.test.ts
priority: high
ordinal: 12000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make the rules and learned knowledge produced by the knowledge-inject step actually reach every agent role. The current workflow builds a context string, but the downstream steps pass `contextFile: null`, so harnesses do not receive the generated context.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Research, test-write, code-write, and verify roles all receive the current rules and recent learned knowledge.
- [x] #2 The context delivery mechanism works across the supported harnesses without requiring provider SDKs or API tokens.
- [x] #3 Large or missing context is handled predictably without crashing the workflow.
- [x] #4 Tests prove that the built context is passed into each step or written to a file consumed by each step.
- [x] #5 The implementation preserves the existing `rules/` and `.pipeline/knowledge` conventions.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implementation plan:
1. Work in dedicated `wt` branch/worktree `pipe-12-knowledge-context` based on updated `main`.
2. Make the context produced from `rules/` and `.pipeline/knowledge` actually reach research, test-write, code-write, and verify roles.
3. Use the existing harness abstraction; do not introduce provider SDKs or API-token handling.
4. Handle missing or large context predictably and preserve the existing rules/knowledge directory conventions.
5. Add tests proving context is delivered to each relevant step or consumed through a context file, then run `bun run test`, `bun run typecheck`, and `bun run check`; run `bun run build` if workflow exports change; commit scoped branch changes before handoff.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Knowledge injection now writes a stable `.pipeline/knowledge-context.md` file containing current rules and recent learned knowledge, with missing/unreadable directories handled as empty and oversized context truncated predictably. The workflow passes that context file to research, RED/test-write, GREEN/code-write, and VERIFY roles through the existing harness abstraction. Tests cover context file creation, truncation, and role delivery. Verification passed on main: `bun run test`, `bun run typecheck`, `bun run check`, and `bun run build`. Merged implementation commit: e33750a.
<!-- SECTION:FINAL_SUMMARY:END -->
