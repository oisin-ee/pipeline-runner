---
id: PIPE-38.5
title: Build and publish the oisin-pipeline runner image
status: Done
assignee: []
created_date: '2026-06-01 21:04'
updated_date: '2026-06-02 20:41'
labels:
  - pipeline
  - runner
  - docker
  - publish
dependencies:
  - PIPE-38.2
  - PIPE-38.3
  - PIPE-38.4
references:
  - package.json
  - README.md
  - .github/workflows/publish.yml
  - /Users/oisin/dev/pipeline-console/chart/values.yaml
modified_files:
  - Dockerfile
  - .dockerignore
  - .github/workflows/publish.yml
  - package.json
  - tests/runner-image.test.ts
parent_task_id: PIPE-38
priority: high
ordinal: 62000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## What

Package the repository as the container image referenced by completed `pipeline-console` chart values:

```yaml
pipeline:
  runner:
    image: ghcr.io/oisin-ee/oisin-pipeline-runner:latest
```

## Image requirements

- Build the TypeScript package before packaging.
- Default command runs the Kubernetes runner entrypoint from PIPE-38.2.
- Include Bun, Node, git, and the package's built `dist/` output.
- Include or explicitly validate the external CLIs required by the default runner profiles. If a required CLI is absent, `doctor` and the runner startup path must fail with a clear prerequisite error before doing work.
- Do not include `pipeline-console` source, server dependencies, migrations, or database clients.

## Publishing

Extend the existing publish workflow so it can publish the npm package and the runner image without conflating their artifacts. The image must be tagged with immutable git SHA tags and the mutable tag expected by `pipeline-console` values.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `Dockerfile` builds a runnable image whose default command is the runner Job entrypoint and whose build context excludes backlog, test output, local run state, and node_modules churn not needed in the final image.
- [x] #2 An image smoke test runs the container with a malformed or minimal payload and proves the command reaches runner validation rather than failing due to missing binary/module wiring.
- [x] #3 The publish workflow builds and pushes `ghcr.io/oisin-ee/oisin-pipeline-runner:<git-sha>` and `ghcr.io/oisin-ee/oisin-pipeline-runner:latest` or the repository's configured mutable release tag.
- [x] #4 The image does not contain `pipeline-console` application code and does not require a console checkout at runtime.
- [x] #5 `bun run build`, `bun run typecheck`, package tests, and the image smoke test are documented as the verification commands for this ticket.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added Dockerfile, .dockerignore, test:image, runner image tests, and a separate publish workflow job for ghcr.io/oisin-ee/oisin-pipeline-runner tagged by git SHA and latest. Verified the image builds and reaches runner payload validation via bun run test:image.
<!-- SECTION:FINAL_SUMMARY:END -->
