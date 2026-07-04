---
id: PIPE-104
title: yeet as moka spawn runner — Phase 0+1 opencode parity
status: To Do
assignee: []
created_date: '2026-07-04 10:55'
labels:
  - epic
dependencies: []
priority: high
ordinal: 341000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Make yeet (Rust agent-spawn binary, ~/dev/yeet) moka's runner via the executor seam (contracts.ts:370), proven at opencode parity before any teardown. First slice of the strangler→wholesale-replacement plan: yeet emits versioned JSON contracts, moka consumes generated TS types + a yeet-backed executor selected alongside the opencode-SDK executor, and a parity gate proves identical RunnerEventRecord streams. yeet=process durability / Argo=orchestration. Release pipeline + claude/codex widen + console yeet-serve are LATER phases, not this epic. Assumptions (user AFK at scope time): backlog home = this repo; parity runs against locally-built yeet (release deferred); opencode-only parity target.
<!-- SECTION:DESCRIPTION:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 All child tickets Done with per-criterion evidence; opencode parity gate green
<!-- DOD:END -->
