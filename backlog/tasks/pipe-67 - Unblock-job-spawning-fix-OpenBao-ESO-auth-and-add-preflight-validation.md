---
id: PIPE-67
title: 'Unblock job spawning: fix OpenBao/ESO auth and add preflight validation'
status: To Do
assignee: []
created_date: '2026-06-11 20:41'
labels:
  - infra
  - devops
dependencies: []
priority: high
ordinal: 199000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 6: infrastructure unblocking. The owner spent a week struggling to spawn jobs; the root cause is infra, not the pipeline code. From ~/dev/infra repo scan: (1) CRITICAL: ClusterSecretStore/openbao is Ready=False due to OpenBao Kubernetes auth config drift (INFRA-050 blocked on INFRA-051.04 auto-unseal). Until this is fixed, ExternalSecrets for pipeline-runner cannot sync (event-auth secret missing). (2) Secret wiring is fragile: multiple recent commits (0d783f4, ef0d390, c7701b4, 57f8475) added missing auth keys/RBAC, proving incomplete upfront specification. After PIPE-59/60/61/62/63/64/65/66 code refactors land, add ONE diagnostic tool to the moka CLI: `moka doctor --cluster <namespace>` (default: momokaya-pipeline). This tool value-free-checks (no secrets read): does every secret by name exist in the namespace? Does the ServiceAccount have the right RBAC? Does the Kueue queue exist? Does the Argo Workflow CRD exist? Print what is missing, so the operator can fix infra without guessing. Then add a minimal e2e test: submit a one-node plan, wait for admission, completion, event delivery.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The moka doctor tool exists as a CLI subcommand or `--doctor` flag.
- [ ] #2 It checks (without reading values): secret existence, RBAC permissions, queue/workflow CRD readiness in the target namespace.
- [ ] #3 Output is actionable (e.g., "Secret pipeline-runner-event-auth missing in momokaya-pipeline; create it from OpenBao path agent-runtime/pipeline-runner/event-auth").
- [ ] #4 A minimal e2e test (local or in-cluster) submits a one-node plan, verifies admission and event delivery.
- [ ] #5 Documentation: troubleshooting runbook with moka doctor invocation examples.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
After Phase 5 code refactors land, add the preflight tool and minimal e2e. The infra repo (~/dev/infra) has separate owner responsibility for fixing OpenBao auth (INFRA-050).
<!-- SECTION:PLAN:END -->
