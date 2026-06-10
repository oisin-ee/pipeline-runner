---
id: PIPE-53.1
title: 'k8s-submit: core submission module + tests'
status: Done
assignee: []
created_date: '2026-06-09 19:53'
updated_date: '2026-06-10 14:10'
labels:
  - implementation
  - superseded
dependencies: []
references:
  - src/k8s-submit.ts
  - src/runner-job-contract.ts
  - src/runner-job/k8s.ts
modified_files:
  - src/k8s-submit.ts
  - tests/k8s-submit.test.ts
parent_task_id: PIPE-53
priority: high
ordinal: 159000
---

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 k8sSubmitOptionsSchema.parse(input) validates and defaults all fields; rejects unknown keys
- [ ] #2 k8sSecretRefSchema rejects missing name or key; rejects extra fields
- [ ] #3 submitK8sRunnerJob() creates ConfigMap + Job in target namespace when cluster is reachable
- [ ] #4 Returns { jobName, namespace } on success
- [ ] #5 Throws descriptive error when git remote missing (no origin URL)
- [ ] #6 Throws descriptive error when kubeconfig missing or cluster unreachable
- [ ] #7 Generated Job manifest includes all five volume mounts (payload, event auth, codex auth, opencode auth, github auth) with documented mount paths
- [ ] #8 Generated payload includes correct contractVersion, command, repository context, and run identity
- [ ] #9 Unit tests mock @kubernetes/client-node APIs and simple-git; verify manifest shape, payload shape, secret ref defaults, and error paths
- [ ] #10 No unsafe casts, no any types, no @ts-ignore
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
New files: src/k8s-submit.ts (~180 lines), tests/k8s-submit.test.ts (~200 lines).

Exports: submitK8sRunnerJob(options: K8sSubmitOptions): Promise<K8sSubmitResult>

Schemas (Zod, following runner-job-contract.ts patterns):
- k8sSecretRefSchema: { name: string.min(1), key: string.min(1) }.strict()
- k8sSubmitOptionsSchema: entrypoint (RunnerExecutionCommand), task (string.min(1)), orchestrator (enum codex|opencode, default opencode), namespace (string.min(1)), eventUrl (string.url()), kubeconfigPath (optional), jobName (optional, regex DNS label), serviceAccountName (default pipeline-runner), imagePullSecretName (optional), codexAuth (k8sSecretRef default codex-auth-1/auth.json), opencodeAuth (k8sSecretRef default opencode-auth-1/auth.json), eventAuth (k8sSecretRef default pipeline-runner-event-auth/token), githubAuth (k8sSecretRef default pipeline-runner-github-auth/hosts.yml). .strict()
- k8sSubmitResultSchema: { jobName, namespace }.strict()

Function does 4 sequential ops:
1. Detect git context via simple-git: remote origin URL, baseBranch (current branch or main), HEAD sha. Fail if no git repo or no remote.
2. Build runner job payload via buildRunnerJobPayload() from @oisincoveney/pipeline/runner-job-contract. Auto-generate run identity (run-<date>-<short-sha>). Task kind prompt. events.authTokenFile = /etc/pipeline/event-auth/<eventAuth.key>.
3. Create ConfigMap via @kubernetes/client-node CoreV1Api.createNamespacedConfigMap(). Name: pipeline-payload-<run-id>. Data: payload.json key.
4. Create Job via @kubernetes/client-node BatchV1Api.createNamespacedJob(). Manifest from buildRunnerJobK8sManifest() adapting structured opts to flat BuildRunnerJobK8sManifestOptions. Job name: pipeline-run-<entrypoint>-<short-sha> or opts.jobName.

Library: @kubernetes/client-node v1.4.0 (official kubernetes-client/javascript, Apache-2.0). Uses KubeConfig, CoreV1Api, BatchV1Api.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Superseded by PIPE-54. Do not implement this k8s Job/--local plan; the accepted direction is the Moka submit command surface backed by Argo Workflows.
<!-- SECTION:FINAL_SUMMARY:END -->
