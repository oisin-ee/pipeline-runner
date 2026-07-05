---
id: PIPE-91.14
title: >-
  Route run-control writers through the durable store seam
  (supervisor/reporter/createRun)
status: Done
assignee: []
created_date: "2026-06-26 21:29"
updated_date: "2026-06-26 21:54"
labels: []
dependencies: []
parent_task_id: PIPE-91
ordinal: 288000
---

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 With db.url set, a run's createRun + recordEvent + updateNodeStatus + updateNodeSession + writeNodeArtifact persist to Postgres via resolveRunControlStore (not .pipeline/runs) -- Evidence: drive the writer path with db.url set, assert run-control rows in cluster PG
- [ ] #2 moka status/runs read back the PG-written run-control state for that run -- Evidence: write via supervisor/reporter then read via the command path from a fresh process
- [ ] #3 db.url absent: writers stay byte-identical to today (.pipeline/runs filesystem) -- Evidence: existing supervisor/reporter/program tests pass unchanged
- [ ] #4 Scheduler untouched; lifecycle (PG close) owned by the writer entrypoints -- Evidence: scheduler diff empty; pnpm run check green
<!-- AC:END -->
