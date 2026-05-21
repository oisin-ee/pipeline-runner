---
id: PIPE-14
title: Add tracer-bullet end-to-end pipeline test
status: To Do
assignee: []
created_date: '2026-05-21 09:20'
labels:
  - e2e
  - tracer-bullet
dependencies:
  - PIPE-11
  - PIPE-12
  - PIPE-13
references:
  - src/index.ts
  - src/mastra/workflows/pipeline.ts
  - tests/
priority: high
ordinal: 14000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add a deterministic end-to-end tracer bullet that proves the pipeline can run through the full lifecycle without depending on external AI CLIs. The test should exercise the same public entrypoints a user will rely on and verify artifacts, statuses, and final outcome.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A fake or fixture harness can simulate researcher, test-writer, code-writer, and verifier behavior deterministically.
- [ ] #2 The tracer-bullet run exercises knowledge injection, RED, GREEN, VERIFY, LEARN, and backlog phase creation/status updates.
- [ ] #3 The test asserts final PASS and validates the expected research or knowledge artifacts are written.
- [ ] #4 A failure-path tracer proves the run reports FAIL and leaves phase status evidence correctly.
- [ ] #5 The tracer-bullet test runs in CI/local verification without requiring Claude, Codex, OpenCode, Pi, or network access.
<!-- AC:END -->
