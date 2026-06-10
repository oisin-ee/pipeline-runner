---
id: PIPE-53.4
title: 'k8s-submit: update skill and command files for k8s by default'
status: Done
assignee: []
created_date: '2026-06-09 19:53'
updated_date: '2026-06-10 14:10'
labels:
  - docs
  - superseded
dependencies:
  - PIPE-53.3
references:
  - .agents/skills/quick/SKILL.md
  - .agents/skills/execute/SKILL.md
  - .agents/plugins/oisin-pipeline/commands/quick.md
  - .agents/plugins/oisin-pipeline/commands/execute.md
  - .opencode/commands/quick.md
  - .opencode/commands/execute.md
modified_files:
  - .agents/skills/quick/SKILL.md
  - .agents/skills/execute/SKILL.md
  - .agents/plugins/oisin-pipeline/commands/quick.md
  - .agents/plugins/oisin-pipeline/commands/execute.md
  - .opencode/commands/quick.md
  - .opencode/commands/execute.md
parent_task_id: PIPE-53
priority: high
ordinal: 162000
---

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 All 6 files reference oisin-pipeline k8s-run instead of oisin-pipeline run
- [ ] #2 All 6 files mention --event-url as a required argument
- [ ] #3 All 6 files document oisin-pipeline run --local as the local fallback
- [ ] #4 No other content changes in any file
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Update 6 files, identical change in each:

.agents/skills/quick/SKILL.md
.agents/skills/execute/SKILL.md
.agents/plugins/oisin-pipeline/commands/quick.md
.agents/plugins/oisin-pipeline/commands/execute.md
.opencode/commands/quick.md
.opencode/commands/execute.md

Change invocation line from:
  Run 'oisin-pipeline run --entrypoint quick <task description>' to generate and execute the schedule artifact.
to:
  Run 'oisin-pipeline k8s-run --entrypoint quick --event-url <event-sink-url> <task description>' to submit the pipeline as a k8s job.
  The pipeline runtime executes inside a Kubernetes pod. Use 'oisin-pipeline run --local --entrypoint quick <task description>' for local execution instead.

Also update the description line from 'It launches configured Codex/OpenCode agent subprocesses...' to reflect k8s execution.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Superseded by PIPE-54. Do not implement this k8s Job/--local plan; the accepted direction is the Moka submit command surface backed by Argo Workflows.
<!-- SECTION:FINAL_SUMMARY:END -->
