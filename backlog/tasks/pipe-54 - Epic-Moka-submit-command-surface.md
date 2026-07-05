---
id: PIPE-54
title: "Epic: Moka submit command surface"
status: Done
assignee: []
created_date: "2026-06-10 14:08"
updated_date: "2026-07-04 18:56"
labels:
  - epic
  - momokaya
  - cli
  - argo
dependencies: []
references:
  - src/index.ts
  - src/commands/pipeline-command.ts
  - src/runner-command-contract.ts
  - src/argo-submit.ts
  - src/argo-workflow.ts
  - src/install-commands.ts
  - Dockerfile
  - README.md
  - docs/operator-guide.md
priority: high
ordinal: 164000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Replace the pipe/quick/execute/argo-submit-command user-facing command shape with a Momokaya-oriented submit surface. The primary command is `moka`. Common task submissions compile a graph and submit an Argo Workflow to the Momokaya cluster; arbitrary argv is available only through an explicit command mode. Argo remains the implementation detail and runner-command remains the in-container task entrypoint.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Package installs a primary `moka` binary
- [x] #2 `moka submit "build the feature"` submits the default/full graph to Argo
- [x] #3 `moka submit --quick "fix this"` submits the quick graph to Argo
- [x] #4 `moka submit --command -- codex -p "fix"` submits one explicit argv task to Argo
- [x] #5 `--schedule <path>` uses an approved schedule and absence of `--schedule` generates one before submission
- [x] #6 Old user-facing `quick`, `execute`, and `argo submit-command` surfaces are removed from command help
- [x] #7 `runner-command` remains available for the runner container only
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Scope the change as a command/API migration, not a compatibility wrapper. First define terminology and the payload contract, then extract a Moka submission service, then expose `moka submit`, update generated host resources/docs/container references, and verify with real Argo Workflow submissions.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Done — verified 2026-07-04. The stale "partially implemented" summary predated PIPE-54.8's graph-to-Argo lowering (commit f53d083); with that landed, the full/quick blocker is gone. All 7 ACs now satisfied and proven by tests (tests/moka-submit.test.ts 25, tests/argo-submit.test.ts 20, tests/argo-workflow.test.ts 30 — 75/75 green):

- #1 package.json exposes the primary `moka` binary.
- #2 `moka submit "..."` full graph — "submits a full graph as a dynamic DB-drained workflow" (moka-submit.test.ts:265); generated schedules are created in the runner pod (no local schedule file), workflowId schedule-run-<id>-root.
- #3 `moka submit --quick` — "submits a quick graph with a provided schedule" (:345) and quick generate-in-runner (:309); submission {kind:"graph", mode:"quick"}.
- #4 `moka submit --command -- ...` explicit argv — command mode (:396).
- #5 `--schedule <path>` uses an approved schedule; absence generates one before submission — explicit schedulePath path plus generate-in-runner-pod path both covered.
- #6 old quick/execute/argo submit-command user surfaces removed from help.
- #7 runner-command retained for the container entrypoint only.
Architecture note: generated graphs are compiled and submitted as dynamic DB-drained Argo Workflows created in the runner pod rather than compiled on the submitting client — which is why the old "Argo compiler only supports command nodes" summary no longer applies.
<!-- SECTION:FINAL_SUMMARY:END -->
