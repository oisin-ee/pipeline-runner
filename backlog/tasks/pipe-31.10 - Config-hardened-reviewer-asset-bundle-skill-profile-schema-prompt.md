---
id: PIPE-31.10
title: 'Config: hardened-reviewer asset bundle (skill + profile + schema + prompt)'
status: Done
assignee: []
created_date: '2026-05-28 17:46'
updated_date: '2026-05-28 22:04'
labels:
  - drain
  - config
milestone: m-0
dependencies: []
references:
  - /Users/oisin/.codex/plans/right-now-we-have-parallel-abelson.md
  - .pipeline/profiles.yaml
  - .pipeline/schemas/
  - .pipeline/prompts/
  - .agents/skills/hardened-review/SKILL.md
modified_files:
  - .pipeline/profiles.yaml
  - .pipeline/prompts/hardened-review.md
  - .pipeline/schemas/review.schema.json
  - tests/config.test.ts
  - tests/cli.test.ts
  - tests/dogfood-installed.test.ts
parent_task_id: PIPE-31
priority: medium
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## What

Add the asset bundle for the final `review` node in `epic-drain`:

- `hardened-review` skill registration in `.pipeline/profiles.yaml` `skills:` block, pointing at the installed skill directory.
- `pipeline-hardened-reviewer` profile that consumes the skill and emits a structured review verdict.
- `.pipeline/schemas/review.schema.json` — JSON schema for the reviewer's output.
- `.pipeline/prompts/hardened-review.md` — instructions wrapping the skill for use as a final review.

## Why

The `review` node in `epic-drain` (PIPE-31.8) calls `profile: pipeline-hardened-reviewer`. The reviewer uses the `hardened-review` skill (an external skill the user found online) to review the integration branch that `drain-merge` produced. Without this bundle the workflow can't load.

## Skill registration (.pipeline/profiles.yaml)

```yaml
skills:
  hardened-review:
    path: .agents/skills/hardened-review/SKILL.md
```

The user installs the skill separately (download / clone into `.agents/skills/hardened-review/`). This task only registers the pointer. If the skill file isn't present at install time, `pipe validate` will emit a `missing-file-reference` warning — that's expected and documents the missing dependency.

## Profile (.pipeline/profiles.yaml)

```yaml
profiles:
  pipeline-hardened-reviewer:
    runner: codex
    filesystem: read-only
    skills: [hardened-review]
    mcp_servers: [serena, semgrep, github-readonly]
    instructions:
      path: .pipeline/prompts/hardened-review.md
    output:
      format: json_schema
      schema_path: .pipeline/schemas/review.schema.json
```

Follow surrounding-profile conventions for any other fields (rules, tools, etc.).

## Schema (.pipeline/schemas/review.schema.json)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["verdict", "findings"],
  "properties": {
    "verdict": { "enum": ["PASS", "FAIL"] },
    "summary": { "type": "string" },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["severity", "message"],
        "properties": {
          "severity": { "enum": ["info", "warn", "error", "critical"] },
          "message":  { "type": "string" },
          "file":     { "type": "string" },
          "line":     { "type": "integer", "minimum": 1 },
          "rule":     { "type": "string" }
        }
      }
    }
  }
}
```

`verdict` drives the existing `verdict` gate in the `review` node. `PASS` = green; `FAIL` = the gate fails the workflow.

## Prompt (.pipeline/prompts/hardened-review.md)

```
# Hardened review

You are the final reviewer of an integration branch produced by drain-merge. Your goal is a hardened review of the changes — security, correctness, scope discipline, and obvious quality issues — using the `hardened-review` skill loaded into your context.

## Inputs

- The integration branch name and base SHA come through your task context (set by upstream drain-merge).
- Use `git diff <baseSha>..HEAD` to enumerate the changes.
- Use the `serena` MCP for code understanding, `semgrep` MCP for static checks, and `github-readonly` MCP only if you need to consult related PRs or issues.
- Follow the `hardened-review` skill's exact methodology — do not invent your own checklist.

## Output

Emit a JSON document conforming to `.pipeline/schemas/review.schema.json`:

- `verdict`: `"PASS"` if the integration is safe to merge to main, else `"FAIL"`.
- `summary`: 2-4 sentences describing what changed and your overall confidence.
- `findings`: zero or more items at varying severities. `critical` or `error` findings must drive a `FAIL` verdict.

Do not modify any files. Do not invoke other agents. Do not push or open PRs.
```

## Tests (tests/config.test.ts)

1. `pipeline-hardened-reviewer` profile parses against the profile schema.
2. `review.schema.json` is itself a valid JSON Schema.
3. With the skill file present at `.agents/skills/hardened-review/SKILL.md` (place a stub for the test): `pipe validate --strict` does not emit `missing-file-reference` for this profile.
4. With the skill file absent: `pipe validate` emits exactly one `missing-file-reference` warning targeted at the skill path (verifies the lint is targeted).

## Dependencies

Independent of other config tasks. The workflow that uses this profile (PIPE-31.8) lists this task as a dependency, not the other way around.

## Reference

`/Users/oisin/.codex/plans/right-now-we-have-parallel-abelson.md` §"Profile and skill additions for the example".
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `skills.hardened-review` registered in `.pipeline/profiles.yaml` pointing at `.agents/skills/hardened-review/SKILL.md`
- [x] #2 `pipeline-hardened-reviewer` profile added with `filesystem: read-only`, `skills: [hardened-review]`, `mcp_servers: [serena, semgrep, github-readonly]`, instructions at `.pipeline/prompts/hardened-review.md`, output `json_schema` -> `.pipeline/schemas/review.schema.json`
- [x] #3 `.pipeline/schemas/review.schema.json` defines required `verdict` (PASS|FAIL) and `findings` array with severity/message/file/line/rule
- [x] #4 `.pipeline/prompts/hardened-review.md` created with the review instructions text
- [x] #5 Profile schema validation passes; JSON schema is itself a valid JSON Schema
- [x] #6 With the skill file present, `pipe validate --strict` emits no `missing-file-reference` for this profile
- [x] #7 With the skill file absent, `pipe validate` emits exactly one `missing-file-reference` warning targeting the skill path
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added the hardened-review asset bundle: skill registration, reviewer profile, review output schema, and prompt. Added focused tests for profile/schema/prompt contracts and present/absent skill missing-file-reference behavior. Updated dogfood config loading to defer lint-missing external skill references without creating the external skill. Verified with acceptance PASS, verifier PASS, focused tests, full tests, typecheck, semgrep, and duplication gate.
<!-- SECTION:FINAL_SUMMARY:END -->
