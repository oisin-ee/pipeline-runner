---
id: PIPE-100
title: Stop leaking per-run ConfigMaps (ownership or GC)
status: Done
assignee: []
created_date: '2026-07-02 14:30'
updated_date: '2026-07-02 17:48'
labels: []
dependencies:
  - PIPE-99
references:
  - src/argo-submit.ts
  - src/runtime/services/kubernetes-argo-service.ts
  - 'https://kubernetes.io/docs/concepts/architecture/garbage-collection/'
modified_files:
  - src/argo-submit.ts
  - src/runtime/services/kubernetes-argo-service.ts
  - tests/argo-submit.test.ts
priority: high
ordinal: 337000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
What to build: Ensure every per-run ConfigMap created by moka's Argo submit path is owned by the Workflow that consumes it, so Workflow deletion/TTL triggers Kubernetes garbage collection.
Scope: static and dynamic Argo submit ordering, ConfigMap metadata ownerReferences, Kubernetes service methods needed to create/patch/delete ConfigMaps, and submit tests that inspect created resources.
Dependencies / Blocked by: PIPE-99, because both tickets edit argo-submit option/model flow and tests; PIPE-99 should land first to avoid overlapping manifest-shape churn.
Likely modified files: src/argo-submit.ts, src/runtime/services/kubernetes-argo-service.ts, tests/argo-submit.test.ts.
Research required: Kubernetes ownerReferences and garbage collection rules; @kubernetes/client-node CoreV1Api methods for patch/delete ConfigMaps if using post-create patch or cleanup.
Model recommendation:
- Claude: unknown -- no Claude model inventory evidenced in this Codex session.
- Codex: gpt-5.5-high -- multi_agent_v1 metadata exposes gpt-5.5 with high reasoning; choose high because ordering/cleanup affects live cluster resource leaks and failure rollback.
- OpenCode: moka-code-writer/default -- defaults/profiles.yaml defines moka-code-writer and defaults/pipeline.yaml routes implementation through broker/gpt-5.5 fallbacks; dispatch must revalidate live availability.
Implementation decisions:
- Use Kubernetes ownerReferences with apiVersion `argoproj.io/v1alpha1`, kind `Workflow`, created workflow name, and created workflow UID.
- Workflow UID exists only after create; either create deterministic ConfigMaps after Workflow create or patch ConfigMaps immediately after create. If the Workflow cannot start before ConfigMaps exist, use a two-phase path and explicitly test rollback/cleanup.
- Do not rely only on labels; labels are discoverability, not garbage-collection ownership.
Escalation:
- Met: every AC below with command output.
- Unmet: criterion id, failing command/output, and whether blocker is Kubernetes API method support, Argo startup ordering, or lack of cluster access for cascade proof.
Origin: pipeline-console target-state spec (pipeline-console/backlog/docs/doc-8), 2026-07-02 audit.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Static submitted run ConfigMaps carry ownerReferences to the created Workflow -- Evidence: argo-submit unit/integration test captures payload, schedule, and task descriptor ConfigMaps with ownerReferences matching workflow name and UID.
- [x] #2 Dynamic submitted run ConfigMap carries ownerReferences to the created Workflow -- Evidence: argo-submit unit/integration test captures payload ConfigMap ownerReferences matching workflow name and UID.
- [x] #3 Failure after partial resource creation does not leave ownerless per-run ConfigMaps -- Evidence: test injects post-workflow or post-configmap failure and asserts cleanup or owned resources.
- [x] #4 Deleting/TTLing the Workflow cascades ConfigMap deletion -- Evidence: kind/k3d/manual cluster check recorded, or explicit blocker if live cluster proof is unavailable.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 The feature-implementation workflow was run in order.
- [x] #2 `bun run test -- tests/argo-submit.test.ts` passed.
- [x] #3 `bun run typecheck` passed.
- [x] #4 `bun run check` passed.
- [x] #5 Cluster cascade proof recorded, or AC #4 escalated with access blocker and exact local proof that did run.
<!-- DOD:END -->
