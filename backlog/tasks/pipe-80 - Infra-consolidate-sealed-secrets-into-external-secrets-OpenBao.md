---
id: PIPE-80
title: "Infra: consolidate sealed-secrets into external-secrets + OpenBao"
status: Done
assignee: []
created_date: "2026-06-12 20:11"
updated_date: "2026-06-13 15:27"
labels:
  - "repo:infra"
  - phase-3
  - hygiene
dependencies:
  - PIPE-77
  - PIPE-81
references:
  - report/architecture-review-2026-06-12.md
priority: low
ordinal: 11000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

The cluster runs two secret pipelines: sealed-secrets (kubeseal-encrypted YAML in git, hand-rolled rotation scripts in bin/rotate-\*, keypair backups in secrets-backups/) and external-secrets + OpenBao (already used for runner event-auth rotation with PushSecret generators).

Migrate the remaining sealed secrets to OpenBao-backed ExternalSecrets, then retire the kubeseal scripts and the keypair-backup ritual. One secret store, one rotation story.

Lowest urgency in the plan — pure simplification, do last.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Inventory of all remaining SealedSecret resources with a migration target for each
- [x] #2 All migrated to ExternalSecrets backed by OpenBao; workloads reload correctly (reloader annotations verified)
- [x] #3 sealed-secrets controller, bin/rotate-\* kubeseal scripts, and secrets-backups keypair process removed or archived
- [x] #4 Documented recovery story for OpenBao (unseal keys / Raft snapshot backup) replacing the keypair backups
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Execution: procedural ops work — no top models.

1. Inventory all SealedSecret resources + migration targets — model=haiku, parallelizable per namespace/directory.
2. Migration plan review (anything credential-rotation-sensitive flagged) — model=sonnet, single pass.
3. Migration execution — model=sonnet, sequential per secret (live-cluster changes; do NOT parallelize writes to the cluster).
4. Script/keypair retirement + recovery-story doc — model=sonnet.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

Decision 2026-06-12 (Oisin): direct-to-main commits on infra authorized. Secrets migrations are still sequential per secret with immediate workload-reload verification — revert on failure.

<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

ALREADY COMPLETE — done by INFRA-058 (decommissioned 2026-06-13), discovered during execution. The review's premise was stale.

Verified state: zero SealedSecret resources in git, no bin/rotate-\* kubeseal scripts, the sealedsecrets CRD does not exist in the cluster, no sealed-secrets controller pod or ArgoCD app. All secrets now live in OpenBao + External Secrets Operator (extensive ExternalSecret manifests across rondo/jalgpall/language-learner/memory/autofix/roborev/observability/platform-auth/openbao). AC#1/2/3 satisfied. AC#4 (recovery story): documented in docs/runbooks/openbao-bootstrap.md, docs/adr/openbao-auto-unseal.md, and daily GCS raft snapshots (k8s/manifests/openbao/snapshots/cronjob.yaml); migration runbook at docs/runbooks/sealed-secrets-to-openbao-migration.md.

Only remnant: secrets-backups/\*.age keypair snapshots, which secrets-backups/README.md explicitly marks DEPRECATED and "Scheduled for deletion on or after 2026-07-13" (30-day rollback grace). Deliberately NOT deleted now — removing them before that date would violate the documented grace window. They become safely deletable on/after 2026-07-13.

<!-- SECTION:FINAL_SUMMARY:END -->
