---
id: PIPE-45.2
title: Split config schema ownership
status: Done
assignee: []
created_date: "2026-06-27 14:03"
updated_date: "2026-06-27 14:28"
labels: []
dependencies:
  - PIPE-45.1
references:
  - src/config/schemas.ts
  - src/config/validate.ts
modified_files:
  - src/config/schemas.ts
  - src/config/validate.ts
  - tests/config.test.ts
parent_task_id: PIPE-45
priority: high
ordinal: 297000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation
Scope: Split src/config/schemas.ts into domain schema modules and keep src/config/validate.ts as validation owner. Move cross-reference validation out of schema assembly where it improves ownership.
Dependencies: PIPE-45.1
Likely modified files: src/config/schemas.ts, src/config/schema/\*, src/config/validate.ts, tests/config.test.ts
Reuse: Zod remains schema/validation library; no local parser replacement.
Escalation: report Met/Unmet criteria with evidence/blocker.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 Config schema construction is split by domain without config behaviour drift -- Evidence: tests/config.test.ts and public API/config tests pass.
- [x] #2 Cross-reference validation has one owner outside raw schema assembly where practical -- Evidence: source inspection and focused invalid-config assertions.
- [x] #3 src/config/schemas.ts falls below 1k lines or records a specific structural justification -- Evidence: wc/fallow output.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

Implementation evidence (2026-06-27):

Research/reuse:

- Local: inspected src/config/schemas.ts, src/config/validate.ts, src/config.ts public exports, config tests, MCP gateway tests, and direct config/schemas importers.
- Reuse: kept Zod as the only schema engine, kept validatePipelineConfig as semantic validation owner, and kept package/public config exports stable. No new dependency and no parser replacement.

Change:

- Moved config enum/default catalog data to src/config/schema/catalog.ts.
- Moved MCP server/gateway schemas to src/config/schema/mcp.ts.
- Moved config cross-reference superRefine rules to src/config/schema/reference-validation.ts.
- Kept src/config/schemas.ts as facade/schema assembly owner and updated src/config/validate.ts to import internal catalog constants from their owner.

Proof commands:

- wc -l src/config/schemas.ts src/config/schema/\*.ts: schemas.ts 766 lines; catalog.ts 85; mcp.ts 144; reference-validation.ts 169. Previous schemas.ts baseline was 1111 lines.
- bunx vitest run tests/config.test.ts tests/package-public-api.test.ts tests/opencode-project-gateway-scope.test.ts tests/mcp-repo-local-backends.test.ts tests/mcp-toolhive-vmcp.test.ts: passed, 5 files, 79 tests.
- bun run typecheck: passed.
- bun run check: passed, 395 files checked, no fixes applied.
- bun run test: passed, 144 files passed, 5 skipped; 1087 tests passed, 41 skipped. Skips are existing env-gated live suites.
- pnpm exec fallow health --production --complexity --targets --hotspots --report-only --top 20: completed; metrics 45,321 LOC, maintainability 89.5, 158 complexity findings total. The old src/config/schemas.ts high-complexity MCP refinement now appears under src/config/schema/mcp.ts, proving ownership moved rather than hidden.
- git diff --check: passed.
- rg as any/as unknown/@ts-ignore/@ts-expect-error/TODO/for now/workaround over touched config files: no matches in the diff-owned files.

Code Rubric:

- Declarative PASS: reference checks are registry-rule data in reference-validation.ts; package catalog values are data in catalog.ts.
- Modular/deep PASS: MCP schema rules and cross-reference validation have named owners; schemas.ts composes them.
- One owner PASS: config catalog constants, MCP schemas, and config reference rules each live in one module.
- Typed/total PASS: Zod schemas and typed ConfigReferenceInput validate boundaries; no unsafe casts/suppressions added.
- Reuse PASS: existing Zod/config validation path reused; no new deps.
- No smells PASS: bun run check/typecheck, git diff --check, and smell grep clean.
- Verified PASS: focused tests, full suite, line count, and fallow report ran fresh.

Critique:

- Correctness: behaviour preserved through config, public API, and MCP tests.
- Security: MCP URL/auth-header validation moved intact; no secret handling changed.
- Performance: no runtime hot path added; import split reduces config facade size without new dependency load for public config users beyond existing Zod path.
- Maintainability: src/config/schemas.ts dropped below 1k and cross-reference validation left schema assembly.

Final audit update after pre-commit feedback:

- Pre-commit fallow-audit initially rejected the moved MCP refinement because the branch cluster remained complex in its new module. Fixed root shape by replacing the branch cluster with mcpServerRefinements data and one refinement loop.
- pnpm exec fallow audit --changed-since HEAD --production: exit 0; no new issues in 6 changed files, 8 inherited config validation findings excluded by the new-only gate.
- Final wc: src/config/schemas.ts 766; src/config/schema/catalog.ts 85; src/config/schema/mcp.ts 157; src/config/schema/reference-validation.ts 169.
- Final bunx vitest run tests/config.test.ts tests/package-public-api.test.ts tests/opencode-project-gateway-scope.test.ts tests/mcp-repo-local-backends.test.ts tests/mcp-toolhive-vmcp.test.ts: passed, 5 files, 79 tests.
- Final bun run test: passed, 144 files passed, 5 skipped; 1087 tests passed, 41 skipped.
- Final bun run check, bun run typecheck, and git diff --check passed.
<!-- SECTION:NOTES:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [x] #1 Run feature-implementation workflow in order and record proof.
<!-- DOD:END -->
