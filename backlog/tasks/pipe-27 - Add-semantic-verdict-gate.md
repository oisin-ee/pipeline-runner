---
id: PIPE-27
title: Add semantic verdict gate
status: Done
assignee: []
created_date: "2026-05-25 20:02"
updated_date: "2026-05-25 20:32"
labels:
  - gates
  - verification
dependencies:
  - PIPE-25
priority: high
ordinal: 39000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Add a generic runtime gate that evaluates structured verdict output semantically. Today `json_schema` can prove that verifier output has the right shape, but valid JSON such as `{ "verdict": "FAIL", "evidence": ["missing coverage"] }` can still satisfy the schema. The runtime needs a separate semantic gate so configured workflows can fail when a verifier or acceptance node reports failure.

This gate must be tool-agnostic. It should parse JSON from stdout or an artifact and compare a configured field value to a configured required value. The first use case is `verdict === "PASS"`, but the implementation should avoid coupling to verifier agents or a specific schema beyond the configured field/default.

Scope:

- Extend gate config with a `verdict` gate kind.
- Support `target: stdout` and `target: artifact` with `path` for artifacts.
- Support a required verdict value, defaulting to `PASS` if omitted.
- Produce clear `RuntimeGateResult` evidence and reason on malformed JSON, missing verdict, or wrong verdict.
- Keep `json_schema` structural-only; do not overload it with domain semantics.

Non-goals:

- Do not implement per-acceptance-criterion coverage in this task.
- Do not hardcode Backlog, tests, verifier profile names, or task IDs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Config supports a verdict gate kind.
- [x] #2 Gate can read JSON from stdout or an artifact path.
- [x] #3 Gate passes only when the configured verdict requirement is met, defaulting to PASS.
- [x] #4 A verifier output with verdict FAIL fails even if it matches JSON schema.
- [x] #5 Existing json_schema gate remains structural only.
- [x] #6 Runtime tests cover PASS, FAIL, malformed JSON, missing verdict, missing artifact, and artifact verdicts.
- [x] #7 Config tests cover valid and invalid verdict gate shapes.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

1. Add `verdict` to the gate kind enum/schema and validate supported fields.
2. Implement verdict gate evaluation in the runtime near existing command/artifact/builtin/json_schema gate evaluation.
3. Reuse existing output/artifact JSON parsing helpers where practical; otherwise add a small local parser with useful failure evidence.
4. Add runtime tests for stdout PASS, stdout FAIL, malformed stdout, missing verdict, artifact PASS, missing artifact, and artifact FAIL.
5. Add config tests that accept valid verdict gates and reject invalid target/path combinations.
6. Add a YAML-runtime regression test where verifier output is valid schema JSON with `verdict: "FAIL"` and the workflow fails because of the verdict gate.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Added generic verdict gates for stdout/artifact JSON, default PASS requirement, clear failure evidence for malformed/missing/wrong verdicts, and tests proving JSON schema remains structural only.

<!-- SECTION:FINAL_SUMMARY:END -->
