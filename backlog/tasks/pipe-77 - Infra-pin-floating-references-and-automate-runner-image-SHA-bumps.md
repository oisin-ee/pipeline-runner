---
id: PIPE-77
title: 'Infra: pin floating references and automate runner image SHA bumps'
status: Done
assignee: []
created_date: '2026-06-12 20:10'
updated_date: '2026-06-13 16:03'
labels:
  - 'repo:infra'
  - phase-3
  - hygiene
dependencies: []
references:
  - report/architecture-review-2026-06-12.md
  - /Users/oisin/dev/infra/k8s/apps/platform/pipeline-console.yaml
priority: high
ordinal: 8000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Three drift points in /Users/oisin/dev/infra:

1. pipeline-runner image SHA is hand-bumped in k8s/apps/platform/pipeline-console.yaml:65 — add a Renovate regex manager (renovate.json5 already exists) to track ghcr.io/oisin-ee/pipeline-runner digests, or evaluate ArgoCD Image Updater.
2. infra-dev-workspace uses :latest while everything else is SHA-pinned — pin it (flake build output tag + reference).
3. The pipeline-console ArgoCD Application tracks the chart repo HEAD with no targetRevision — pin to a tag or release branch so a chart restructure can't silently break the inline Helm values.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Renovate (or Image Updater) automatically proposes pipeline-runner image SHA bumps; verified with one real bump PR
- [ ] #2 infra-dev-workspace image reference is pinned (no :latest) everywhere it is consumed, including coder-templates and pipeline-console preview-runner values
- [ ] #3 pipeline-console ArgoCD Application has an explicit targetRevision
- [ ] #4 ArgoCD apps remain Synced/Healthy after the changes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Execution: 3 parallel agents, one per drift point — all model=sonnet (YAML/Renovate config; no design work).
1. Renovate regex manager for the runner image SHA.
2. Pin infra-dev-workspace (flake tag + all consumers).
3. targetRevision on the pipeline-console ArgoCD Application.
Verification (ArgoCD apps Synced/Healthy) — model=haiku, single check agent at the end.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Decision 2026-06-12 (Oisin): direct-to-main commits on infra authorized (ArgoCD selfHeal+prune will sync). Verify apps Synced/Healthy immediately after each commit; revert on failure.

Follow-ups completed 2026-06-13: (1) stale Kueue references stripped from 10 infra docs (infra f760e69). (2) infra-dev-workspace was already publishing SHA tags since May (456e67f) — switched both consumers (pipeline-console.yaml preview-runner, coder-templates/dev-workspace/main.tf) from :latest@digest to the SHA tag + added 2 Renovate git-refs customManagers (infra 5bbdccd). (3) pipeline-console now has a v0.1.0 git tag + auto-tag-on-merge publish workflow (console c971057) so infra targetRevision can move to clean semver.

DELIBERATELY NOT DONE: bumping infra pipeline-console.yaml targetRevision from the SHA pin (9e58be2) to v0.1.0. That bump is a PRODUCTION DEPLOY — it ships the session's console work + runs DB migration 0010 (drops k8s_queue_name/k8s_workload_name live) + pulls console image 58f140e (build unverified). Left to Oisin to time/verify; the SHA pin keeps the current deployed console running safely until then. AC#3 (explicit targetRevision) already satisfied by the SHA pin.
<!-- SECTION:NOTES:END -->
