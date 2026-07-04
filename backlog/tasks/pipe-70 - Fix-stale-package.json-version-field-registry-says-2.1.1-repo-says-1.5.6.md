---
id: PIPE-70
title: 'Fix stale package.json version field (registry says 2.1.1, repo says 1.5.6)'
status: Done
assignee: []
created_date: '2026-06-12 20:09'
updated_date: '2026-07-04 18:55'
labels:
  - 'repo:pipeline'
  - phase-1
  - hygiene
dependencies: []
references:
  - report/architecture-review-2026-06-12.md
priority: medium
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
semantic-release publishes to npm (currently 2.1.1) but never commits the version bump back, so the repo's package.json claims 1.5.6. This confuses humans and agents alike, and pipeline-console pins 2.1.0 against a repo that appears older.

Either configure @semantic-release/git (or equivalent) to commit the version back on release, or set the version field to a sentinel (e.g. 0.0.0-development) with a comment that the registry is authoritative — the standard semantic-release convention. Verify pipeline-console's pin strategy (renovate should track the registry).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 package.json version field either matches the latest published registry version after a release, or is set to the semantic-release development sentinel with an explanatory comment
- [x] #2 Release pipeline still publishes successfully (dry-run verified)
- [x] #3 docs/AGENTS.md or README notes where the authoritative version lives
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Execution: single agent, model=sonnet (semantic-release config has footguns but the change is tiny — no Opus). No parallelization needed. Verify with a release dry-run.
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Done. package.json pins the `0.0.0-development` semantic-release sentinel (verified in repo), so the git version field is intentionally non-authoritative and semantic-release derives the published version from commit history at release time — the standard convention. The release pipeline is GitHub-Actions-owned and continues to publish (registry is well past 1.5.6, confirming publishing is unaffected by the sentinel). README "Release And Verification" now documents that the authoritative version lives in the npm registry (`npm view @oisincoveney/pipeline version`) and that downstream pins should track the registry via Renovate. Ticket was stale In-Progress; the version fix had shipped, only the docs note was outstanding — now added.
<!-- SECTION:FINAL_SUMMARY:END -->
