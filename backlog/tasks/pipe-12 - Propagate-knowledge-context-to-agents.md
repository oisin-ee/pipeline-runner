---
id: PIPE-12
title: Propagate knowledge context to agents
status: To Do
assignee: []
created_date: '2026-05-21 09:19'
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
priority: high
ordinal: 12000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make the rules and learned knowledge produced by the knowledge-inject step actually reach every agent role. The current workflow builds a context string, but the downstream steps pass `contextFile: null`, so harnesses do not receive the generated context.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Research, test-write, code-write, and verify roles all receive the current rules and recent learned knowledge.
- [ ] #2 The context delivery mechanism works across the supported harnesses without requiring provider SDKs or API tokens.
- [ ] #3 Large or missing context is handled predictably without crashing the workflow.
- [ ] #4 Tests prove that the built context is passed into each step or written to a file consumed by each step.
- [ ] #5 The implementation preserves the existing `rules/` and `.pipeline/knowledge` conventions.
<!-- AC:END -->
