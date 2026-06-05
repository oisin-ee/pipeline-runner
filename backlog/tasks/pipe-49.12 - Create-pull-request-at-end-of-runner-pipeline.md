---
id: PIPE-49.12
title: Create pull request at end of runner pipeline
status: To Do
assignee: []
created_date: '2026-06-05 12:30'
labels:
  - runner-job
  - github
  - delivery
dependencies:
  - PIPE-49.10
references:
  - src/runner-job-contract.ts
  - src/runner-job
modified_files:
  - src/runner-job
parent_task_id: PIPE-49
priority: high
ordinal: 128000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
At the end of a successful self-contained runner-job pipeline, create a GitHub pull request for the branch or changes produced by the run. The runner job owns this delivery step as part of the pipeline run lifecycle; Pipeline Console only observes the resulting event/artifact.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Successful runner-job pipeline runs can create a GitHub PR from the produced branch or changes.
- [ ] #2 PR creation happens after verification succeeds and before final successful completion is reported.
- [ ] #3 PR URL is emitted as a runner-job event and recorded as a run artifact/evidence.
- [ ] #4 PR creation uses configured GitHub credentials from runner-job env/secrets and never logs tokens.
- [ ] #5 Failed verification does not create a PR.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add a dedicated delivery step after clean-job dogfood proves the pipeline lifecycle. Use GitHub-supported auth/CLI/library path selected during implementation, emit PR metadata, and cover success/failure behavior.
<!-- SECTION:PLAN:END -->
