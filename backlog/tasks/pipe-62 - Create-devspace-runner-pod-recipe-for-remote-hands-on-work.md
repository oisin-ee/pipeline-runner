---
id: PIPE-62
title: Create devspace runner pod recipe for remote hands-on work
status: To Do
assignee: []
created_date: '2026-06-11 20:40'
labels:
  - feature
  - devspace
  - ux
dependencies:
  - PIPE-60
priority: medium
ordinal: 194000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 4 variant: the owner can spawn a long-lived devspace runner pod in the cluster and attach a terminal to it, then run `moka` interactively inside the pod - same environment as Argo jobs, works from anywhere. (Inspired by the tova/rondo devspace setups: `devspace dev --profile runner` -> container with hot-reload sync, live CLI shell.) The pod spec is reused from src/argo-workflow.ts so the dev pod == production pod (perfect for debugging). The recipe docs devspace.yaml or Helm values for the runner image, secret mounts, shared volumes, etc. The owner can then: `devspace dev` -> live in the pod -> run `moka run quick --output-format live` and watch the same terminal rendering (PIPE-61) in real-time.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A devspace.yaml or Helm overrides file exists that spins up the pipeline-runner image as a dev pod with the same mounts/secrets as production.
- [ ] #2 Documentation explains: `devspace dev` in the moka repo -> exec shell -> `moka run quick`.
- [ ] #3 The pod includes dev-mode tools (git, opencode, claude CLI, bun) and synced repo access.
- [ ] #4 The same event stream rendering (PIPE-61) works inside the pod terminal.
<!-- AC:END -->
