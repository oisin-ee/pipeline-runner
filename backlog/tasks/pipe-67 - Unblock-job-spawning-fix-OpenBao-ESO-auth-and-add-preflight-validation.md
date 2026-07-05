---
id: PIPE-67
title: Add cluster preflight doctor for runner job prerequisites
status: Done
assignee: []
created_date: "2026-06-11 20:41"
updated_date: "2026-06-12 08:38"
labels:
  - infra
  - devops
dependencies:
  - PIPE-60.4
priority: high
ordinal: 199000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Phase 6: infrastructure unblocking through diagnostics, not secret repair. The owner spent a week struggling to spawn jobs; the root cause is infra, not the pipeline code. From ~/dev/infra repo scan: (1) CRITICAL: ClusterSecretStore/openbao is Ready=False due to OpenBao Kubernetes auth config drift (INFRA-050 blocked on INFRA-051.04 auto-unseal). Until this is fixed, ExternalSecrets for pipeline-runner cannot sync (event-auth secret missing). (2) Secret wiring is fragile: multiple recent commits (0d783f4, ef0d390, c7701b4, 57f8475) added missing auth keys/RBAC, proving incomplete upfront specification.

After PIPE-59/60/61/62/63/64/65/66 code refactors land, add one diagnostic tool to the moka CLI: `moka doctor --cluster <namespace>` (default: momokaya-pipeline). This tool performs value-free checks only: it may check resource existence, readiness/status conditions, RBAC `can-i` style permissions, queue/CRD presence, and ExternalSecret sync status, but it must never read, print, diff, decode, or validate secret values. Its job is to say which prerequisite is missing or not Ready so the operator can fix infra in the infra repo without guessing. Then add a minimal e2e test: submit a one-node plan, wait for admission, completion, and event delivery.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 The moka CLI exposes `moka doctor --cluster <namespace>` with `momokaya-pipeline` as the default namespace.
- [x] #2 It checks without reading secret values: expected Secret objects exist by name, ExternalSecrets report synced/Ready, ServiceAccount/RBAC permissions are present, Kueue queue is available, and Argo Workflow CRD/controller prerequisites are present.
- [x] #3 It reports OpenBao/ESO readiness as an external prerequisite, including ClusterSecretStore/ExternalSecret Ready status when accessible, but does not attempt to configure OpenBao or mutate Kubernetes resources.
- [x] #4 Output is actionable and value-free, e.g. "Secret pipeline-runner-event-auth missing in momokaya-pipeline; expected ExternalSecret pipeline-runner-event-auth to sync it from agent-runtime/pipeline-runner/event-auth".
- [x] #5 A minimal real-usage e2e submits a one-node plan, verifies admission, waits for completion, and verifies event delivery through the repository's normal CLI/runtime path.
- [x] #6 Troubleshooting docs show `moka doctor` examples, explain the OpenBao/ESO dependency boundary, and point operators to the infra runbook without embedding secret material.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

After Phase 5 code refactors land, add the preflight tool and minimal e2e. The infra repo (`~/dev/infra`) has separate owner responsibility for fixing OpenBao auth (INFRA-050); this repository should surface that readiness state, not repair it. Implement checks through the normal Kubernetes command/API surface already used by the project. Treat lack of cluster access as a clear diagnostic result, not as a reason to silently skip checks.

<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

Non-goals: no `npm publish`, no Docker push, no local secret publishing, no OpenBao token reads, no secret value reads from Kubernetes, and no mutation of ExternalSecret/Secret/ClusterSecretStore resources. The diagnostic may name expected resources and secret keys/paths because those are configuration contracts, but it must not inspect the values behind them.

<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Accepted after real cluster verification. Evidence: moka doctor --cluster momokaya-pipeline --kube-context momokaya produced value-free diagnostics without secret values; Release/image path published ghcr.io/oisin-ee/pipeline-runner@sha256:2aaf1b3dd506bc117aefcd471e438a07319997078e0f84f4f03626548088f3d8 with @oisincoveney/pipeline@1.29.3 and package-owned skills present; workflow pipe-67-doctor-smoke-20260612-0835 admitted with UID da42d0c3-7e96-4e32-ac2b-d37850b664e1, reached Succeeded, all main containers exited 0 on that image digest, logs showed task.run passed, git.node-ref.push finished, and event.flush finished. External OpenBao/ESO/RBAC failures remain surfaced by doctor as infra prerequisites, not repo-code blockers.

<!-- SECTION:FINAL_SUMMARY:END -->
