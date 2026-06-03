---
id: PIPE-18
title: Add generated slash command installer
status: Done
assignee: []
created_date: '2026-05-21 16:38'
updated_date: '2026-05-21 16:42'
labels:
  - cli
  - slash-commands
  - packaging
dependencies: []
references:
  - src/index.ts
  - src/install-commands.ts
  - README.md
priority: high
ordinal: 18000
---

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 CLI uses a real command framework for work-next and install-commands
- [x] #2 install-commands can install all supported host adapters
- [x] #3 Installer supports idempotent update, dry-run, check, and force behavior
- [x] #4 Generated files are marked as package-owned and manual edits are protected
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added Commander-based CLI dispatch for work-next and install-commands. Implemented generated command installation for Codex, OpenCode, Codex, and Pi with package-owned markers, idempotent updates, dry-run, check, and force semantics. Added tests covering all-host installation, idempotency, check failures, dry-run, manual-edit protection, and force overwrite. Verified with full tests, typecheck, Ultracite check, build, npm publish dry-run, and packed consumer install proof.
<!-- SECTION:FINAL_SUMMARY:END -->
