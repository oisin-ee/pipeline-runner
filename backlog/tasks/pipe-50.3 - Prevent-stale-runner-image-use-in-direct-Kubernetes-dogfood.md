---
id: PIPE-50.3
title: Prevent stale runner image use in direct Kubernetes dogfood
status: Done
assignee: []
created_date: '2026-06-06 09:12'
updated_date: '2026-06-06 09:17'
labels:
  - runner-job
  - kubernetes
  - image
  - dogfood
dependencies: []
references:
  - src/runner-job/k8s.ts
  - Dockerfile
  - .github/workflows/publish.yml
modified_files:
  - src/runner-job/k8s.ts
  - docs/operator-guide.md
  - tests/package-public-api.test.ts
  - tests/runner-job-k8s.test.ts
parent_task_id: PIPE-50
priority: high
ordinal: 132000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The direct runner verification first used a stale cluster-configured image c9ab3ddd22ecddec8fabc5dad1fa706c5b10af10, whose runner-job command did not support --payload-file. The actual published latest image accepted the file-mounted payload. The root cause was that runner Job producers had to pass an image into the package manifest builder, allowing stale cluster/app image config to enter the Job spec. Runner Job creation should not select an image; it should use the package-owned latest runner image and always pull it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `buildRunnerJobK8sManifest` no longer requires or consumes caller-provided runner image selection.
- [x] #2 Runner Job manifests always use `ghcr.io/oisin-ee/pipeline-runner:latest` with `imagePullPolicy: Always`.
- [x] #3 A regression test proves a stale caller-provided image cannot override the package-owned runner image.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Move image ownership into the package manifest builder. Remove image from the public typed options, set the canonical latest image and explicit always-pull policy in the generated Job, and document that runner Job producers do not select image refs.
<!-- SECTION:PLAN:END -->
