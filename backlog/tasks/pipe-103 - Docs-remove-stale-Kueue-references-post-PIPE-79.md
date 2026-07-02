---
id: PIPE-103
title: 'Docs: remove stale Kueue references post PIPE-79'
status: Done
assignee: []
created_date: '2026-07-02 14:31'
labels: []
dependencies: []
priority: low
ordinal: 340000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Workflow: feature-implementation
What: README.md:201 and docs/pipeline-console-runner-contract.md:5-6 still describe Kueue discovery; docs/operator-guide.md:319-321 claims console runner settings include queue name/TTL/deadline (false today). Correct all three to the Argo-Workflow submit-and-observe reality (and note TTL/deadline become real only with the submit-threading ticket).
Scope: README.md, docs/pipeline-console-runner-contract.md, docs/operator-guide.md

Origin: pipeline-console target-state spec (pipeline-console/backlog/docs/doc-8), 2026-07-02 audit.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 No kueue references outside historical backlog files -- Evidence: `rg -i "kueue" README.md docs/` returned no matches.
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [x] #1 docs updated. Evidence: README.md, docs/pipeline-console-runner-contract.md, and docs/operator-guide.md align to Argo Workflow submit-and-observe wording; `nub run check` passed.
<!-- DOD:END -->
