---
id: PIPE-53.5
title: 'k8s-submit: document k8s prerequisites and k8s-run usage'
status: To Do
assignee: []
created_date: '2026-06-09 19:54'
labels:
  - docs
dependencies:
  - PIPE-53.3
references:
  - docs/operator-guide.md
modified_files:
  - docs/operator-guide.md
parent_task_id: PIPE-53
priority: high
ordinal: 163000
---

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Section documents all required Secrets with exact names and keys
- [ ] #2 Section documents k8s-run command syntax with required and optional flags
- [ ] #3 Section documents --local fallback
- [ ] #4 No formatting errors in the Markdown
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Add new section to docs/operator-guide.md after the existing runner-job documentation (~line 207).

Section content:

### K8s-native pipeline execution (k8s-run)

The k8s-run command submits pipeline runs as Kubernetes Jobs. The command builds a runner job payload from the task description and current git context, creates a ConfigMap, and submits a batch/v1 Job that runs the pipeline inside a pod.

#### Prerequisites

The following must exist in the target namespace:

- ServiceAccount pipeline-runner with RBAC to read pods/logs
- Secret codex-auth-1 with key auth.json (Codex auth)
- Secret opencode-auth-1 with key auth.json (OpenCode auth)
- Secret pipeline-runner-event-auth with key token (event sink bearer token)
- Secret pipeline-runner-github-auth with keys gitconfig, git-credentials, hosts.yml (GitHub auth)
- A pipeline-console event sink endpoint reachable from the pod

#### Usage

oisin-pipeline k8s-run --entrypoint quick --event-url https://console.example.com/api/pipeline/runner-events --namespace pipeline-runs 'fix the login bug'

#### Local execution

Use --local on the run command for workstation-local execution:

oisin-pipeline run --local --entrypoint quick 'fix the login bug'
<!-- SECTION:PLAN:END -->
