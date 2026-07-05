---
id: PIPE-22
title: Harden command hook execution
status: Done
assignee: []
created_date: "2026-05-25 13:48"
updated_date: "2026-05-25 20:32"
labels:
  - hooks
  - security
dependencies:
  - PIPE-25
  - PIPE-23
priority: high
ordinal: 34000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Make command hooks safe enough for UI-triggered and app-triggered dispatch across repositories. Hooks remain a project-configured extension point, but the runtime must provide safe defaults and explicit trust controls so a UI cannot accidentally execute arbitrary repo commands without policy.

This task should happen after PIPE-23 because hook hardening needs the final dispatch semantics for workflow, orchestrator, node, and gate hook events.

Scope:

- Add explicit hook enablement/trust policy so hosts or applications can decide whether command hooks are allowed.
- Add timeout defaults and per-hook timeout behavior.
- Add output size limits and truncation evidence for hook stdout/stderr.
- Sanitize hook command environments by default and allow explicit env passthrough/configuration.
- Add structured payload delivery for hook data, preferably JSON stdin or a generated payload file, so complex data does not rely on unsafe string templating.
- Preserve simple templating where it is safe and documented.

Non-goals:

- Do not remove hooks.
- Do not make hooks required for core runtime execution.
- Do not hardcode a notification provider, UI tool, shell, or repo-specific hook command.
- Do not weaken required-vs-optional hook failure semantics.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Hooks support explicit enablement/trust policy, timeouts, output limits, and sanitized env.
- [x] #2 Hooks receive structured payloads without relying on unsafe string templating for complex data.
- [x] #3 Required hook failures still fail the workflow and optional hook failures are recorded without failing the workflow.
- [x] #4 Hook output truncation records evidence without unbounded memory or log growth.
- [x] #5 Hook commands receive sanitized env by default and only configured env values when allowed.
- [x] #6 Tests cover disabled/untrusted hooks, required and optional hooks, timeout, output limit, env sanitization, and structured payloads.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

1. Review hook schema and dispatch paths after PIPE-23 establishes final hook semantics.
2. Add config fields for trust/enablement policy, timeout defaults, output limits, and env policy.
3. Update command-hook execution to enforce timeout, env, and output limits consistently.
4. Add structured hook payload delivery through JSON stdin or a generated payload file while preserving documented simple templating.
5. Add tests for disabled/untrusted hooks, required hook failure, optional hook failure, timeout, output truncation, sanitized env, and structured payload contents.
6. Update docs with safe hook examples and UI-triggering guidance.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Implemented command hook policy controls, sanitized env, timeout/output limits, JSON stdin payloads, required/optional failure preservation, and runtime tests covering policy failures and hook payload execution.

<!-- SECTION:FINAL_SUMMARY:END -->
