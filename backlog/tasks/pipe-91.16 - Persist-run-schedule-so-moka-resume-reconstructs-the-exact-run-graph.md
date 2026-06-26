---
id: PIPE-91.16
title: Persist run schedule so moka resume reconstructs the exact run graph
status: To Do
assignee: []
created_date: '2026-06-26 22:38'
labels: []
dependencies: []
parent_task_id: PIPE-91
ordinal: 290000
---

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A run's schedule/plan is persisted (run-control manifest or durable store) at start -- Evidence: psql shows the schedule for a runId
- [ ] #2 moka resume rebuilds the SAME graph from the persisted schedule, not package config; only unfinished nodes run -- Evidence: kill a custom multi-node run, resume runs only the remaining nodes of that graph
<!-- AC:END -->
