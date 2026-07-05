---
id: PIPE-50.2
title: Force package default acceptance reviewer to emit gate JSON
status: Done
assignee: []
created_date: "2026-06-06 09:12"
updated_date: "2026-06-06 09:12"
labels:
  - runner-job
  - runtime
  - gates
  - codex
dependencies: []
references:
  - src/config.ts
  - src/pipeline-runtime.ts
modified_files:
  - src/config.ts
  - tests/pipeline-runtime.test.ts
parent_task_id: PIPE-50
priority: high
ordinal: 131000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Direct Codex runner Job runner-direct-20260606085245-codex reached the acceptance-review node, but pipeline-acceptance-reviewer returned Markdown/prose beginning with \*\*Acceptance..., causing acceptance-coverage and acceptance-verdict gates to fail JSON parsing. Package-owned default profile instructions are too weak for gate-backed output contracts.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Package default acceptance reviewer instructions require only valid JSON matching the acceptance schema, with no Markdown or prose.
- [x] #2 A regression test proves a gate-backed acceptance profile prompt includes the JSON-only contract and schema expectation.
- [x] #3 A direct or local runner/runtime smoke with a mocked acceptance agent returning prose fails with the existing parse error, while the corrected prompt path requests JSON-only output.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Strengthen package default profile instructions and/or runner prompt assembly for acceptance/verdict-gated nodes so Codex receives an explicit JSON-only contract. Keep validation in gates, do not weaken gate parsing.

<!-- SECTION:PLAN:END -->
