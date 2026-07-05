---
id: PIPE-31.8
title: "Config: epic entrypoint + epic-drain workflow (pipeline.yaml + .gitignore)"
status: Done
assignee: []
created_date: "2026-05-28 17:45"
updated_date: "2026-05-28 22:42"
labels:
  - drain
  - config
milestone: m-0
dependencies:
  - PIPE-31.1
  - PIPE-31.2
  - PIPE-31.3
  - PIPE-31.4
  - PIPE-31.9
  - PIPE-31.10
references:
  - /Users/oisin/.codex/plans/right-now-we-have-parallel-abelson.md
  - .pipeline/pipeline.yaml
  - .gitignore
modified_files:
  - .pipeline/pipeline.yaml
  - .gitignore
  - src/index.ts
  - src/install-commands.ts
  - src/runner.ts
  - tests/config.test.ts
  - tests/cli.test.ts
  - tests/workflow-planner.test.ts
  - tests/install-commands.test.ts
  - tests/dogfood-installed.test.ts
  - .codex/commands/epic.md
  - .opencode/commands/epic.md
  - .opencode/agents/pipeline-epic-router.md
  - .opencode/agents/pipeline-hardened-reviewer.md
  - .agents/skills/epic/SKILL.md
  - .codex/agents/pipeline-epic-router.toml
  - .codex/agents/pipeline-hardened-reviewer.toml
  - .kimi/commands/epic.md
  - .pi/prompts/epic.md
parent_task_id: PIPE-31
priority: high
ordinal: 8000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

## What

Wire the new structural primitives together into a real, runnable feature. Adds the `epic` entrypoint and the `epic-drain` workflow to `.pipeline/pipeline.yaml`. Also adds `.pipeline/runs/` to `.gitignore` so per-run worktree paths don't pollute git status.

## Why

This is the user-visible payoff of the runtime + CLI work: `pipe epic <id>` runs an epic through `research → plan → parallel(four tracks) → drain-merge → hardened-review`. Each parallel track gets its own worktree under `.pipeline/runs/${runId}/<track>/` and runs the `default` workflow (or a track-specific one). The router agent buckets the epic's sub-tickets into tracks; the parallel topology is fixed in YAML.

## YAML additions

`.pipeline/pipeline.yaml`:

```yaml
entrypoints:
  epic:
    workflow: epic-drain
    description: Route an epic's tickets into specialist tracks, run them in parallel, then hardened-review.

workflows:
  epic-drain:
    description: Research, route, parallel-implement tracks in isolated worktrees, integrate, hardened-review.
    nodes:
      - id: research
        kind: agent
        profile: pipeline-researcher

      - id: plan
        kind: agent
        profile: pipeline-epic-router
        needs: [research]

      - id: implement
        kind: parallel
        needs: [plan]
        nodes:
          - id: test
            kind: workflow
            workflow: default
            worktree_root: .pipeline/runs/${runId}/test
          - id: frontend
            kind: workflow
            workflow: default
            worktree_root: .pipeline/runs/${runId}/frontend
          - id: backend
            kind: workflow
            workflow: default
            worktree_root: .pipeline/runs/${runId}/backend
          - id: k8s
            kind: workflow
            workflow: infra
            worktree_root: .pipeline/runs/${runId}/k8s

      - id: merge
        kind: builtin
        builtin: drain-merge
        needs: [implement]

      - id: review
        kind: agent
        profile: pipeline-hardened-reviewer
        needs: [merge]
        gates:
          - { id: review-verdict, kind: verdict, target: stdout }
```

## The `infra` track sub-workflow

`epic-drain` references a track-specific `infra` workflow for the `k8s` track. Implementations can be deferred (the `default` workflow handles test/frontend/backend), but a stub `infra` workflow is needed for the schema/plan to validate. Minimum: define `infra` in `pipeline.yaml` with the same node shape as `default` — its profiles can differ (different `code-writer` MCP servers, e.g.) but the workflow structure mirrors `default`. Track-specific profiles like `pipeline-infra-code-writer` can be added in a follow-up; this ticket only needs the workflow id `infra` to exist (it may temporarily delegate node-for-node to existing profiles).

## .gitignore

Append `.pipeline/runs/` to `.gitignore` so per-run worktrees, branches, and report artifacts don't show up as untracked changes.

## Tests (tests/config.test.ts)

1. `pipeline.yaml validates with the new epic entrypoint and epic-drain workflow`.
2. `pipe explain-plan --entrypoint epic` prints `research → plan → implement(parallel: test, frontend, backend, k8s) → merge → review`.
3. `pipe validate --entrypoint epic` reports no errors and (with PIPE-31.6) no lints.

## Dependencies

Depends on:

- PIPE-31.1 (`kind: workflow`) — `implement` children use it.
- PIPE-31.2 (`kind: parallel`) — `implement` is a parallel container.
- PIPE-31.3 (`worktree_root` lifecycle) — every `implement` child uses `worktree_root`.
- PIPE-31.4 (`drain-merge` builtin) — `merge` node.
- PIPE-31.9 (`pipeline-epic-router` profile + schema + prompt) — `plan` node references the profile.
- PIPE-31.10 (`pipeline-hardened-reviewer` profile + skill + schema + prompt) — `review` node references the profile.

Note: PIPE-31.9 and PIPE-31.10 are independent of each other and of the runtime tasks; they can be developed in parallel. This task is the final integration — land all five deps before merging this one, or scaffold here first with stub profiles and keep `pipe validate` green throughout.

## Reference

`/Users/oisin/.codex/plans/right-now-we-have-parallel-abelson.md` §"Worked example — epic drain" and §"Profile and skill additions for the example".

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 `.pipeline/pipeline.yaml` defines `entrypoints.epic` and `workflows.epic-drain` exactly per the shape in the description
- [x] #2 `workflows.epic-drain` uses `kind: parallel` containing four `kind: workflow` children with `worktree_root: .pipeline/runs/${runId}/<track>`
- [x] #3 `workflows.epic-drain` has a `drain-merge` builtin node and a `review` agent node with the verdict gate
- [x] #4 `workflows.infra` exists (may delegate to existing default-style profiles in this ticket)
- [x] #5 `.gitignore` appends `.pipeline/runs/`
- [x] #6 `pipe validate --entrypoint epic` exits 0 (no errors or strict-lint failures)
- [x] #7 `pipe explain-plan --entrypoint epic` prints the expected node topology
- [x] #8 Tests added: config parses; explain-plan output matches expected shape
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Added the epic entrypoint and epic-drain workflow with research, epic routing, parallel default/default/default/infra implementation worktrees, drain-merge, and hardened review. Added the infra stub workflow, ignored .pipeline/runs/, updated explain-plan to tolerate lint-only missing references and show parallel children, regenerated all host command surfaces for epic, and tightened tests/dogfood coverage. Verified with acceptance PASS, verifier PASS, focused epic/install/dogfood tests, full tests, typecheck, semgrep, duplication, and learn.

<!-- SECTION:FINAL_SUMMARY:END -->
