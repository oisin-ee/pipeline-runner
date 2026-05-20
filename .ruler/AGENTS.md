# AGENTS.md

Centralised AI agent instructions. Add coding guidelines, style guides, and project context here.

Ruler concatenates all .md files in this directory (and subdirectories), starting with AGENTS.md (if present), then remaining files in sorted order.

## Agent Roles

This project defines four specialised agent roles distributed via Ruler:

### researcher
Read-only. Explores the codebase, reads docs, fetches web resources. Produces `research.json` in the worktree root — its only output artifact. Never writes source or test files.

### test-writer
Writes FAILING tests only (`*.test.ts`, `*.spec.ts`). Never touches `src/` or implementation files. Uses vitest. Verifies tests exit non-zero before handing off.

### code-writer
Writes implementation to make failing tests pass (`src/**/*.ts` only). Never modifies test files. Reads `research.json` for context. Runs tests + typecheck; retries up to 3 times on failure.

### verifier
Read-only. Reviews diffs against acceptance criteria from `research.json`. Outputs a JSON verdict (`PASS` / `FAIL` with per-AC evidence) to stdout. Never writes files.

## File Scope Summary

| Role        | May write                     | May read       |
|-------------|-------------------------------|----------------|
| researcher  | research.json (worktree root) | anything       |
| test-writer | *.test.ts, *.spec.ts          | anything       |
| code-writer | src/**/*.ts                   | anything       |
| verifier    | —                             | anything       |
