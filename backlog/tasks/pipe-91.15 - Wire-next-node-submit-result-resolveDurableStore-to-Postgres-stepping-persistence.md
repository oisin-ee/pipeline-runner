---
id: PIPE-91.15
title: >-
  Wire next-node/submit-result resolveDurableStore to Postgres (stepping
  persistence)
status: To Do
assignee: []
created_date: '2026-06-26 22:38'
labels: []
dependencies: []
parent_task_id: PIPE-91
ordinal: 289000
---

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 resolveDurableStore selects postgresDurableRunStore when db.url set (narrow loadMokaDbUrl), else in-memory -- Evidence: grep shows no inMemory-for-both stub; unit asserts PG store chosen with db.url
- [ ] #2 submit-result awaits write-through + closes the PG client before process exit so the record survives -- Evidence: live test: submit in process B then next-node in process C returns the dependent node; psql shows the row
- [ ] #3 next-node/submit-result read db.url narrowly, not full loadMokaGlobalConfig (no kubernetes/submit required) -- Evidence: command runs with a db.url-only config
<!-- AC:END -->
