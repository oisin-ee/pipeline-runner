---
id: PIPE-50.5
title: Rerun no-console direct runner dogfood through GitHub delivery
status: Done
assignee: []
created_date: "2026-06-06 09:12"
updated_date: "2026-06-06 11:57"
labels:
  - runner-job
  - kubernetes
  - github
  - dogfood
  - verification
dependencies:
  - PIPE-50.2
  - PIPE-50.3
  - PIPE-50.4
  - PIPE-50.6
references:
  - src/runner-job/k8s.ts
  - src/runner-job/delivery.ts
modified_files:
  - src/runner-job/delivery.ts
  - src/schedule-planner.ts
  - tests/runner-job-delivery.test.ts
  - tests/runner-image.test.ts
  - tests/runner-job.test.ts
  - tests/schedule-planner.test.ts
parent_task_id: PIPE-50
priority: high
ordinal: 134000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

The 2026-06-06 direct runner Jobs proved current image startup, file-mounted payloads, auth Secret mounts, Kueue admission, event posting to a non-console sink, schedule generation, and OpenCode workflow node execution. They did not prove GitHub branch push or `gh pr create`: earlier Jobs failed before delivery, and PIPE-50.6 verification ran with `delivery.pullRequest: false` and later failed at Rondo acceptance gates. After the runner blockers are fixed, rerun Codex and OpenCode direct Kubernetes Jobs against Rondo feature tickets without pipeline-console and verify delivery.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Two direct Kubernetes runner Jobs are created without pipeline-console APIs or event endpoints: one codex orchestrator and one opencode orchestrator.
- [x] #2 Both Jobs use a verified current GHCR runner image digest and mount codex-auth-1, opencode-auth-1, oisin-bot-github-auth, ghcr-pull-secret, and pipeline-runner-event-auth by name without reading Secret data.
- [x] #3 At least one successful runner pipeline reaches delivery and proves GitHub auth by pushing a pipeline/\* branch and creating or updating a PR with gh.
- [x] #4 The run records Job names, image digest, event sink evidence, branch/PR evidence, and any remaining failure phase.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Create a temporary non-console event receiver, create two direct runner Jobs from the package manifest builder using the verified current image, wait for terminal state, check branch/PR evidence, then delete temporary receiver and payload ConfigMaps.

<!-- SECTION:PLAN:END -->

## Verification

<!-- SECTION:VERIFICATION:BEGIN -->

Completed on 2026-06-06 without using pipeline-console.

Fixes shipped through GitHub Actions only:

- `925b2fb` delivered failed-runtime branch/PR delivery.
- `ee47594` made PR creation return an existing PR URL when one already exists.
- `d8f20a2` added generated coverage fan-in for uncovered implementation nodes.
- `6b866d1` added `gh` to the runner image.
- `f1fc9b0` made delivery branch reruns use `--force-with-lease`.
- `db87340` defaulted PR head owner to the target repository owner.
- `f346abd` made generated coverage scope-aware for nested `parallel` nodes.

Final release evidence:

- GitHub Actions Release run `27061338784` succeeded for `f346abd2af9f3bfc4f5364c27049e49f415b6bf3`.
- `ghcr.io/oisin-ee/pipeline-runner:f346abd2af9f3bfc4f5364c27049e49f415b6bf3` and `:latest` both resolved to `sha256:f5f8eb442add682339188f488bc7dc148ea76c328e6645347bc47c5c697e1369`.

Final no-console Kubernetes run:

- Event sink: `runner-events-50-5-20260606114511` in namespace `momokaya-pipeline`.
- Codex job: `runner-50-5-20260606114511-codex`.
- OpenCode job: `runner-50-5-20260606114511-opencode`.
- Both Jobs used `ghcr.io/oisin-ee/pipeline-runner:latest`, `imagePullPolicy: Always`, pull secret `ghcr-pull-secret`, and pulled `sha256:f5f8eb442add682339188f488bc7dc148ea76c328e6645347bc47c5c697e1369`.
- Both mounted `codex-auth-1`, `opencode-auth-1`, `oisin-bot-github-auth`, and `pipeline-runner-event-auth` by Secret name only; Secret data was not read.

Delivery evidence:

- OpenCode/RONDO-13 pushed `pipeline/rondo-13` at `c2c47e6e34d0837d4589172089dfdbb68f40e0a1` and created `https://github.com/oisin-ee/rondo/pull/53`.
- Codex/RONDO-12 pushed `pipeline/rondo-12` at `b3ed142befcfff2e13aaf012535296fd4c836a39` and created `https://github.com/oisin-ee/rondo/pull/54`.
- Job stdout for both included:
  - `Runner delivery complete:`
  - `- branch: pipeline/rondo-*`
  - `- commit: ...`
  - `- pull_request: https://github.com/oisin-ee/rondo/pull/...`

Remaining runtime failures were downstream Rondo acceptance failures, not delivery failures:

- OpenCode failed acceptance criterion `6` (`PR 20 merged to main`) but still delivered PR 53.
- Codex failed acceptance/verdict JSON parsing in `acceptance-profile-edit` but still delivered PR 54.
<!-- SECTION:VERIFICATION:END -->
