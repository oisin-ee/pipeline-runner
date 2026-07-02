---
id: PIPE-97
title: Emit CANCELLED terminal outcome on Argo shutdown=Stop
status: Done
assignee: []
created_date: '2026-07-02 14:29'
updated_date: '2026-07-02 17:48'
labels: []
dependencies:
  - PIPE-96
references:
  - src/runner-command/finalize.ts
  - src/remote/argo/templates.ts
  - 'https://argo-workflows.readthedocs.io/en/latest/fields/'
modified_files:
  - src/runner-command/finalize.ts
  - src/runner-event-sink.ts
  - src/remote/argo/templates.ts
  - tests/runner-finalize.test.ts
  - tests/runtime-scheduler-workflow.test.ts
priority: high
ordinal: 334000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
What to build: Make console-initiated Argo Stop produce runner terminal outcome CANCELLED while preserving PASS/FAIL for normal workflow completion.
Scope: finalizer CLI input/schema, Argo finalizer template arguments, finalizer outcome mapping, and any RunnerEventSink call path needed to emit run.cancelled plus workflow.finish CANCELLED.
Dependencies / Blocked by: PIPE-96, because this touches RunnerEventSink terminal delivery and must build on the hardened flush semantics.
Likely modified files: src/runner-command/finalize.ts, src/runner-event-sink.ts, src/remote/argo/templates.ts, tests/runner-finalize.test.ts, tests/runtime-scheduler-workflow.test.ts.
Research required: Argo Workflow status/shutdown condition fields; confirm whether `{{workflow.status}}` is enough or whether the template must pass a stop/shutdown field.
Model recommendation:
- Claude: unknown -- no Claude model inventory evidenced in this Codex session.
- Codex: gpt-5.5-high -- multi_agent_v1 metadata exposes gpt-5.5 with high reasoning; choose high because finalizer outcome mapping crosses Argo, DB-scheduled runs, and event delivery.
- OpenCode: moka-code-writer/default -- defaults/profiles.yaml defines moka-code-writer and defaults/pipeline.yaml routes implementation through broker/gpt-5.5 fallbacks; dispatch must revalidate live availability.
Implementation decisions:
- Do not infer CANCELLED from every non-Succeeded status. Failed/Error still map to FAIL unless Argo exposes a stopped/shutdown signal.
- If Argo exposes no reliable stop signal in current template variables, stop and report the exact field gap rather than mapping all Error/Failed statuses to CANCELLED.
- Preserve dynamic DB-source finalizer status updates; cancelled should not mark missing-node runs as plain blocked/failed without explicit cancellation evidence.
Escalation:
- Met: every AC below with command output.
- Unmet: criterion id, Argo field inspected, why safe cancellation detection is unavailable, and smallest contract change needed.
Origin: pipeline-console target-state spec (pipeline-console/backlog/docs/doc-8), 2026-07-02 audit.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Stop-shutdown run emits run.cancelled and workflow.finish outcome CANCELLED -- Evidence: finalize unit test with stopped/shutdown input and captured event records.
- [x] #2 PASS/FAIL semantics unchanged for normal completion -- Evidence: existing finalize tests plus focused Succeeded/Failed/Error cases stay green.
- [x] #3 Argo template passes the field the finalizer uses for cancellation detection -- Evidence: workflow manifest test asserts finalizer args include the field, or ticket records blocker if Argo lacks it.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 The feature-implementation workflow was run in order.
- [x] #2 `bun run test -- tests/runner-finalize.test.ts tests/runtime-scheduler-workflow.test.ts tests/runner-event-sink.test.ts` passed.
- [x] #3 `bun run typecheck` passed.
- [x] #4 `bun run check` passed.
<!-- DOD:END -->
