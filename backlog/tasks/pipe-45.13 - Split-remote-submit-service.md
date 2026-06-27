---
id: PIPE-45.13
title: Split remote submit service
status: Done
assignee: []
created_date: '2026-06-27 14:03'
labels: []
dependencies:
  - PIPE-45.2
  - PIPE-45.5
references:
  - src/moka-submit.ts
modified_files:
  - src/moka-submit.ts
  - src/remote/submit/argo-submission.ts
  - src/remote/submit/compilation.ts
  - src/remote/submit/contract.ts
  - src/remote/submit/event-boundary.ts
  - src/remote/submit/hook-events.ts
  - src/remote/submit/io.ts
  - src/remote/submit/service.ts
  - tests/moka-submit.test.ts
parent_task_id: PIPE-45
priority: high
ordinal: 308000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
Scope: Split src/moka-submit.ts into input contract, graph compilation, Argo submission service, event sink/auth handling, and the public package entrypoint.
Dependencies: PIPE-45.2, PIPE-45.5
Likely modified files: src/moka-submit.ts, src/remote/submit/*, tests/moka-submit.test.ts
Reuse: ky/fetch/event sink contracts and existing Zod submit schemas; no custom HTTP client.
Escalation: report Met/Unmet criteria with evidence/blocker.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Submit contract, compilation, IO, and event/auth handling have separate owners -- Evidence: `src/moka-submit.ts` owns public submit schemas and parse/submit; `src/remote/submit/{event-boundary,hook-events,io,compilation,argo-submission,service}.ts` own lower submit concerns; source-boundary assertion in `tests/moka-submit.test.ts`.
- [x] #2 Public ./moka-submit contract remains compatible -- Evidence: `bun run test tests/moka-submit.test.ts tests/package-public-api.test.ts tests/dist-contract.test.ts tests/moka-run-remote-compat.test.ts`.
- [x] #3 Security-sensitive auth data remains boundary-validated and not logged -- Evidence: `mokaSubmitOptionsSchema` validates event auth fields in `src/moka-submit.ts`; event token path projection stays in `src/remote/submit/event-boundary.ts`; `bun run typecheck`, `bun run check`, and `pnpm exec fallow audit --changed-since HEAD --production`.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 Run feature-implementation workflow plus security lens for auth/event boundaries; record proof.
<!-- DOD:END -->
