---
id: PIPE-104
title: yeet as moka spawn runner — Phase 0+1 opencode parity
status: To Do
assignee: []
created_date: "2026-07-04 10:55"
updated_date: "2026-07-04 19:41"
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

Groomed 2026-07-04 (verified against code, not text). VERDICT: valid, fully un-started — keep To Do.

Seam confirmed: the executor seam the epic targets lives at src/runtime/contracts/contracts.ts:371-373 (`(plan: RunnerLaunchPlan, options: RunnerExecutionOptions) => AgentResult | Promise<AgentResult>`), NOT `src/contracts.ts:370` as written in the description. There are two contracts.ts files (src/run-control/contracts.ts, src/runtime/contracts/contracts.ts) — the runtime one is the seam. Existing opencode executor: src/runtime/opencode-session-executor.ts.

yeet confirmed at ~/dev/yeet (Rust, edition 2024). RunSpec+Event wire types live in src/spec.rs + src/event.rs; adapters for claude/codex/opencode present. Current yeet HEAD 5e73e5c.

No work started: (1) yeet Cargo.toml has NO schemars dep, no JsonSchema derive, no `yeet schema` subcommand; (2) zero `yeet` references in oisin-pipeline src/ or package.json, no yeet-executor module, no schema-gen script. All 4 subtasks un-started. Epic stays To Do until all children Done + parity gate green.

<!-- SECTION:NOTES:END -->
