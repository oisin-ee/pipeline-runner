---
id: PIPE-90
title: moka ticket completion gate (Layer A)
status: Done
assignee: []
created_date: "2026-06-26 14:24"
updated_date: "2026-06-26 17:30"
labels:
  - epic
dependencies: []
references:
  - docs/moka-orchestrator-design.md
priority: high
ordinal: 261000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Make moka the refusable completion gate for a ticket. Agent calls 'moka ticket complete' with a structured evidence claim; moka adjudicates against the ticket's acceptance criteria via a layered gate (deterministic -> structured-claim -> LLM-judge residue) and either marks Done or returns a STRUCTURED refusal (unmet criteria + reason + evidence). Layer A only: gate mechanism + command. Non-goals: durable Postgres substrate, CLI node-stepping, one-shot planner, re-plan escalation (all Layer B). Design: docs/moka-orchestrator-design.md.

<!-- SECTION:DESCRIPTION:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [ ] #1 All child tickets Done with per-criterion evidence
<!-- DOD:END -->
