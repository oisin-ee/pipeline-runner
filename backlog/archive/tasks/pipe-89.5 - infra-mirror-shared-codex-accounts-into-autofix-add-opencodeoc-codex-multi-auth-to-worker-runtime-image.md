---
id: PIPE-89.5
title: >-
  infra: mirror shared codex accounts into autofix + add
  opencode+oc-codex-multi-auth to worker-runtime image
status: To Do
assignee: []
created_date: '2026-06-22 20:30'
updated_date: '2026-06-22 20:40'
labels: []
dependencies: []
references:
  - >-
    infra/k8s/manifests/pipeline-console/external-secrets/opencode-openai-accounts.yaml
  - infra/k8s/images/pipeline-runner/Dockerfile
modified_files:
  - infra/k8s/manifests/autofix/external-secrets/autofix-secrets.yaml
  - infra/flake.nix
parent_task_id: PIPE-89
priority: high
ordinal: 258000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope (infra repo): (1) ExternalSecret in autofix ns mirroring OpenBao agent-runtime/pipeline-runner/codex-multiauth-accounts property accounts.json (pattern: pipeline-console opencode-openai-accounts-1); (2) worker-runtime Nix image gains the agent-auth CLI + opencode runner + oc-codex-multi-auth (today it ships only raw codex-cli). Cross-repo: github.com/oisin-ee/infra.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 autofix ns gets a Secret with accounts.json from the shared OpenBao path -- Evidence: kubectl get externalsecret -n autofix shows SecretSynced True
- [ ] #2 worker-runtime image contains agent-auth CLI + opencode + oc-codex-multi-auth -- Evidence: in-cluster pod: command -v opencode agent-auth; npm ls oc-codex-multi-auth
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Run feature-implementation workflow in order
- [ ] #2 ExternalSecret SecretSynced + image smoke recorded
<!-- DOD:END -->
