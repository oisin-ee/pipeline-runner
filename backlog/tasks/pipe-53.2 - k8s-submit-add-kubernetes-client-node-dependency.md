---
id: PIPE-53.2
title: 'k8s-submit: add @kubernetes/client-node dependency'
status: To Do
assignee: []
created_date: '2026-06-09 19:53'
labels:
  - dependency
dependencies: []
references:
  - package.json
modified_files:
  - package.json
  - pnpm-lock.yaml
parent_task_id: PIPE-53
priority: high
ordinal: 160000
---

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 package.json lists @kubernetes/client-node ^1.4.0 under dependencies
- [ ] #2 pnpm install succeeds
- [ ] #3 import * as k8s from @kubernetes/client-node resolves in a .ts file without type errors
- [ ] #4 tsdown build succeeds with the new import
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add @kubernetes/client-node v1.4.0 to dependencies in package.json. Run pnpm install to update lockfile. Official npm package from kubernetes-client/javascript, Apache-2.0.
<!-- SECTION:PLAN:END -->
