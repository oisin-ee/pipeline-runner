---
id: PIPE-31.9
title: 'Config: epic-router asset bundle (profile + schema + prompt)'
status: Done
assignee: []
created_date: '2026-05-28 17:45'
updated_date: '2026-05-28 21:45'
labels:
  - drain
  - config
milestone: m-0
dependencies: []
references:
  - /Users/oisin/.claude/plans/right-now-we-have-parallel-abelson.md
  - .pipeline/profiles.yaml
  - .pipeline/schemas/
  - .pipeline/prompts/
modified_files:
  - .pipeline/profiles.yaml
  - .pipeline/prompts/epic-router.md
  - .pipeline/schemas/epic-plan.schema.json
  - tests/config.test.ts
  - tests/cli.test.ts
parent_task_id: PIPE-31
priority: medium
ordinal: 9000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## What

Add the asset bundle for the `plan` node in `epic-drain`:

- `pipeline-epic-router` profile in `.pipeline/profiles.yaml` — read-only agent that reads an epic via Backlog MCP and routes sub-tickets into named tracks.
- `.pipeline/schemas/epic-plan.schema.json` — JSON schema for the router's structured output.
- `.pipeline/prompts/epic-router.md` — instructions explaining the routing task, the four tracks, and the output contract.

## Why

The `plan` node in `epic-drain` (PIPE-31.8) calls `profile: pipeline-epic-router` and validates output against `epic-plan.schema.json`. Without this bundle the workflow can't load.

## Profile (.pipeline/profiles.yaml)

```yaml
profiles:
  pipeline-epic-router:
    runner: codex                           # match the convention in surrounding profiles
    filesystem: read-only
    mcp_servers: [backlog, github-readonly]
    instructions:
      path: .pipeline/prompts/epic-router.md
    output:
      format: json_schema
      schema_path: .pipeline/schemas/epic-plan.schema.json
```

If existing profiles in the file specify `rules:` / `skills:` / `tools:` lists, follow that convention (e.g. likely `rules: [scope-discipline]` since the router is read-only).

## Schema (.pipeline/schemas/epic-plan.schema.json)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["test", "frontend", "backend", "k8s"],
  "properties": {
    "test":     { "type": "array", "items": { "$ref": "#/$defs/ticket" } },
    "frontend": { "type": "array", "items": { "$ref": "#/$defs/ticket" } },
    "backend":  { "type": "array", "items": { "$ref": "#/$defs/ticket" } },
    "k8s":      { "type": "array", "items": { "$ref": "#/$defs/ticket" } },
    "rationale": { "type": "string" }
  },
  "$defs": {
    "ticket": {
      "type": "object",
      "additionalProperties": false,
      "required": ["id"],
      "properties": {
        "id":    { "type": "string" },
        "title": { "type": "string" },
        "rationale": { "type": "string" }
      }
    }
  }
}
```

The four track keys are intentionally required and fixed — the topology in `epic-drain` is fixed in YAML, and the schema reflects that. A track with zero assigned tickets is `"track": []`, not omitted.

## Prompt (.pipeline/prompts/epic-router.md)

Contents (write this file with this text; it captures the routing task for whichever LLM runs the profile):

```
# Epic router

You read an epic ticket and its sub-tickets via the Backlog MCP server, then route each sub-ticket into exactly one of four named tracks: test, frontend, backend, k8s. You output a JSON document matching `.pipeline/schemas/epic-plan.schema.json`.

## Inputs

- The user's task is an epic id (or a description that names one). Use the Backlog MCP `task_view` and `task_search` tools to find the epic and enumerate its sub-tickets.
- For each sub-ticket, read its title, description, labels, and any referenced files.

## Routing rules

Pick the single best-fit track per ticket. Heuristics, in priority order:

1. **k8s** — anything touching deployment, Kubernetes manifests, Helm charts, infra YAML, CI/CD pipelines, Docker, ingress, RBAC, cluster config.
2. **backend** — server-side APIs, services, database schema, server-side data flows, MCP servers, non-UI integrations.
3. **frontend** — UI components, client-side state, styling, browser interactions, accessibility, Figma-referenced work.
4. **test** — work that is *primarily* writing or restructuring tests (e.g. coverage uplift, harness changes). Don't route a feature ticket here just because it mentions tests — features go to their domain track and write their own tests there.

Ties: prefer **backend > frontend > test > k8s** unless a strong signal flips it.

A track may be empty (`[]`).

## Output

Emit a single JSON document conforming to the schema. Include a short `rationale` string explaining notable routing decisions.

Do not modify any files. Do not invoke other agents.
```

## Tests (tests/config.test.ts or tests/install-commands.test.ts as appropriate)

1. `pipeline-epic-router` profile parses against the profile schema.
2. `epic-plan.schema.json` is itself a valid JSON Schema (parse + ajv validate).
3. `pipe validate` no longer warns `missing-file-reference` for `pipeline-epic-router` once this bundle is present.

## Dependencies

Independent of other config tasks. The workflow that uses this profile (PIPE-31.8) lists this task as a dependency, not the other way around.

## Reference

`/Users/oisin/.claude/plans/right-now-we-have-parallel-abelson.md` §"Profile and skill additions for the example" and §"How parallelism is decided".
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `pipeline-epic-router` profile added to `.pipeline/profiles.yaml` with `filesystem: read-only`, `mcp_servers: [backlog, github-readonly]`, instructions pointing to `.pipeline/prompts/epic-router.md`, output `json_schema` -> `.pipeline/schemas/epic-plan.schema.json`
- [x] #2 Profile conforms to surrounding-profile conventions (runner, rules/skills/tools where applicable)
- [x] #3 `.pipeline/schemas/epic-plan.schema.json` created with the four required track keys (test/frontend/backend/k8s), each an array of `ticket` objects with `id` (required), `title`, `rationale`
- [x] #4 `.pipeline/prompts/epic-router.md` created with the routing instructions text
- [x] #5 Profile schema validation passes; JSON schema is itself a valid JSON Schema
- [x] #6 `pipe validate --strict` does not emit `missing-file-reference` for the epic-router profile
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added the epic-router asset bundle: profile, prompt, and fixed-track epic plan schema. Added focused config/CLI tests for the profile contract, schema behavior, prompt contract, and missing-file lint coverage. Verified with acceptance PASS, verifier PASS, focused tests, validate --no-lint, typecheck, full tests, semgrep, and duplication gate.
<!-- SECTION:FINAL_SUMMARY:END -->
