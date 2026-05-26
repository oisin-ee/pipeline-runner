---
id: PIPE-24
title: Add first-class entrypoint aliases
status: Done
assignee: []
created_date: '2026-05-25 13:48'
updated_date: '2026-05-25 20:32'
labels:
  - config
  - entrypoints
dependencies:
  - PIPE-25
priority: medium
ordinal: 36000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Support configured entrypoint aliases such as `pipe`, `quick`, `inspect`, or `ticket-intake` that map to workflows and shared runner/profile configuration. Today callers select workflows directly or rely on generated command names that are effectively hardcoded. Entrypoints should provide a stable app/CLI-facing name that resolves to a workflow plus optional defaults.

This should build on the YAML-only runtime after PIPE-25. It must not hardcode project-specific aliases in core. Projects define aliases in config; CLI/library/generated host adapters resolve aliases through the config.

Scope:
- Add config schema for named entrypoints.
- Resolve entrypoint aliases to workflow IDs and optional default task/context behavior.
- Add CLI/library API support for selecting an entrypoint without hardcoding workflow IDs in callers.
- Update generated host command resources so project entrypoints can produce commands/prompts if configured.
- Preserve direct workflow selection for advanced callers.

Non-goals:
- Do not implement task-context resolvers here.
- Do not hardcode any specific alias in core.
- Do not remove workflow IDs as a low-level concept.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Pipeline config can declare named entrypoints mapped to workflows.
- [x] #2 CLI and library APIs can select an entrypoint without hardcoding workflow ids in callers.
- [x] #3 Config validation rejects entrypoints pointing at missing workflows or duplicate invalid names.
- [x] #4 Direct workflow selection remains supported and precedence with entrypoint selection is documented.
- [x] #5 Generated host resources can expose configured entrypoints without hardcoding project aliases in core.
- [x] #6 Tests cover config parsing, CLI/library resolution, generated resources, and missing-workflow failures.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Design `entrypoints` config shape with name, workflow, description, and optional defaults.
2. Add config validation for duplicate/missing workflows and invalid entrypoint IDs.
3. Add runtime/CLI resolution from entrypoint name to workflow ID.
4. Keep direct `--workflow` support and define precedence when both workflow and entrypoint are supplied.
5. Update install-command generation so host commands can be generated from entrypoints instead of only the default workflow.
6. Add config, CLI, runtime, and install-command tests.
7. Update docs with examples for multiple entrypoints sharing profiles/runners.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added configured entrypoint aliases, CLI/runtime resolution with workflow precedence, validation for missing workflow references, generated host resource exposure, docs, and tests.
<!-- SECTION:FINAL_SUMMARY:END -->
