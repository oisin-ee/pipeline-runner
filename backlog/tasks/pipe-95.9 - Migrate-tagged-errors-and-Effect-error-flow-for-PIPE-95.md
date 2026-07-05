---
id: PIPE-95.9
title: Clear CLI config MCP credentials strict lint for PIPE-95
status: To Do
assignee: []
created_date: "2026-07-05 19:19"
updated_date: "2026-07-05 18:34"
labels:
  - migration
dependencies:
  - PIPE-95.5
references:
  - >-
    backlog/tasks/pipe-95.5 -
    Stabilize-post-autofix-strict-lint-baseline-for-PIPE-95.md
  - /tmp/pipe95-controller-oxlint-after-format.json
  - oxlint.config.ts
modified_files:
  - src/cli
  - src/config
  - src/credentials
  - src/install-commands
  - src/mcp
  - src/claude-settings-config.ts
  - src/claude-user-config.ts
  - src/codex-config.ts
  - src/opencode-project-config.ts
  - tests/cli.test.ts
  - tests/config.test.ts
  - tests/credentials-boundaries.test.ts
  - tests/install-commands.test.ts
  - tests/mcp-gateway-renderers.test.ts
  - tests/mcp-repo-local-backends.test.ts
  - tests/mcp-toolhive-vmcp.test.ts
  - tests/moka-doctor-readiness.test.ts
  - tests/opencode-project-config.test.ts
  - tests/opencode-project-gateway-scope.test.ts
parent_task_id: PIPE-95
priority: medium
ordinal: 354000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
What to build: Clear strict/type-aware/Effect lint diagnostics owned by CLI command surfaces, config loading/schema, host install/config projection, MCP gateway config, credentials, and paired tests.
Scope: src/cli/**, src/config/**, src/credentials/**, src/install-commands/**, src/mcp/\*\*, host config projection files, and paired tests. Do not touch runtime core, runner, run-control, planning/schedule, tickets, or package metadata unless recording a transferred residual.
Dependencies / Blocked by: PIPE-95.5.
Likely modified files: CLI/config/MCP/credentials files and paired tests named by the fresh lint JSON.
Research required: inspect existing config schemas, host projection helpers, credentials broker patterns, safe JSON helpers, and service wrappers before edits.
Model recommendation:

- Claude: unknown -- no Claude model inventory is exposed in this session.
- Codex: gpt-5.5-high -- command/config lane has public CLI behaviour risk; current host exposes gpt-5.5.
- OpenCode: moka-code-writer/default -- dispatch must revalidate live availability.
  Escalation:
- Met: CLI/config/MCP diagnostics clear with focused tests and typecheck.
- Unmet: record exact file/rule/count and missing config/schema/service contract.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 CLI/config/MCP diagnostics are cleared. -- Evidence: parsed oxlint JSON filtered to this lane write boundary shows zero errors except transferred residuals with rule/file/count.
- [ ] #2 CLI/config/MCP behaviours remain covered. -- Evidence: focused tests for touched files pass and nub run typecheck exits 0.
- [ ] #3 Write boundary is respected. -- Evidence: review lists any out-of-bound file touched and why it was required, otherwise no out-of-bound source/test edits.
- [ ] #4 No shortcut suppressions or type escapes are introduced. -- Evidence: git diff --check exits 0 and added-line escape scan exits 1.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

Filter lint JSON to CLI/config/MCP/credentials paths, group by public command or config contract, repair one seam at a time, run focused tests, then rerun filtered counts and typecheck.

<!-- SECTION:PLAN:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [ ] #1 The ticket global-rules feature-implementation workflow was run in order.
- [ ] #2 Focused proof ran fresh and output was recorded.
- [ ] #3 Required verify/review step passed, or blocker was reported in structured form.
<!-- DOD:END -->
