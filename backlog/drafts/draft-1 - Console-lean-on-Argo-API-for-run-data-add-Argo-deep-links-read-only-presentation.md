---
id: DRAFT-1
title: >-
  Console: lean on Argo API for run data + add Argo deep-links (read-only
  presentation)
status: Draft
assignee: []
created_date: "2026-06-13 15:57"
labels:
  - "repo:console"
  - architecture
  - future
dependencies: []
references:
  - report/architecture-review-2026-06-12.md
  - report/hatchet-spike-go-no-go-2026-06-13.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

FUTURE DIRECTION — Oisin will revisit; not active (raised 2026-06-13).

pipeline-console should evolve toward a nice READ-ONLY presentation surface over Argo Workflows (actively maintained, popular) rather than growing hand-rolled run reconstruction:

1. Add deep-links from console run views to the corresponding Argo Workflows UI (workflow/run). Needs an Argo UI base URL in console config.
2. Pull useful run data directly from the Argo API into the console (workflow status, per-node phases/timings, pod/log references) instead of (or alongside) reconstructing it from the raw runner event stream in run-detail-builder.ts.
3. Keep the run views rendered IN the console (the DAG via XYFlow, timeline, gates) — do NOT bounce the user out to Argo as the primary experience. Console = home; Argo = source + secondary forensics link.

Constraint from PIPE-76: the bespoke reconstruction (collectTimeline/collectNodes/collectEdges) stays until a deliberate Argo-sourced replacement exists — don't delete it speculatively. Gates/acceptance/ticket domain views are console-only (Argo has no concept of them) and always stay.

Open questions to settle when picking this up: Argo API auth/reachability from the console server; how much of run-detail can be Argo-sourced vs must stay event-sourced (gates/acceptance are runner-emitted, not in Argo); whether to keep the runner-event-sink at all for Argo-executed runs.

<!-- SECTION:DESCRIPTION:END -->
