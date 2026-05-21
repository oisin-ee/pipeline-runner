---
id: PIPE-17
title: Make package installable from tarball
status: Done
assignee: []
created_date: '2026-05-21 16:20'
updated_date: '2026-05-21 16:21'
labels:
  - packaging
  - cli
dependencies: []
references:
  - package.json
  - README.md
  - src/index.ts
priority: high
ordinal: 17000
---

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Package exposes installed work-next and oisin-pipeline binaries
- [x] #2 Package exports typed primitive and runner adapter subpaths
- [x] #3 Packed tarball installs into a clean consumer repo without linking
- [x] #4 Installed binaries and imports are smoke-tested from the consumer repo
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added installable package binaries for work-next and oisin-pipeline, built CLI/runtime bundles during prepack, and exposed typed subpath exports for pipeline-primitive and runner. Verified from a packed tarball installed into /tmp/oisin-pipeline-consumer without linking: both binaries resolve and run to harness validation, runtime imports work, TypeScript subpath imports typecheck, and slash-command/docs templates are included. Full repo tests, typecheck, Ultracite check, and Mastra build passed.
<!-- SECTION:FINAL_SUMMARY:END -->
