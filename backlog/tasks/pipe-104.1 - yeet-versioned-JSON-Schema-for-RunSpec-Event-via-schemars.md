---
id: PIPE-104.1
title: "yeet: versioned JSON Schema for RunSpec + Event via schemars"
status: Done
assignee: []
created_date: "2026-07-04 10:55"
updated_date: "2026-07-07 09:47"
labels: []
dependencies: []
parent_task_id: PIPE-104
priority: high
ordinal: 342000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workflow: feature-implementation. What to build: yeet emits a versioned, machine-readable JSON Schema for its RunSpec (input) and Event (output) wire types — the contract moka/console bind to across the Rust↔TS boundary. Add schemars, derive JsonSchema on RunSpec+Event+their members, expose a `yeet schema` subcommand (or build.rs emit) that prints both schemas with a top-level schema_version field. Scope: ~/dev/yeet repo only — src/spec.rs, src/event.rs, Cargo.toml, a schema command in src/cli.rs/main.rs. Research required: schemars docs (derive, versioning) via research + library-first-development. Model recommendation — Claude: Sonnet (localized Rust, single repo; claude 2.1.199 installed); Codex: gpt-5.5-medium (installed 0.142.5); OpenCode: MoKa Code Writer default (1.17.12 installed).

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 `yeet schema` prints valid JSON Schema covering RunSpec and every Event variant -- Evidence: piped through a JSON Schema validator, exit 0
- [ ] #2 Schema carries a stable schema_version field -- Evidence: snapshot test pins version + shape; changing a wire type without bumping fails the test
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

Groomed 2026-07-04. Un-started, valid. Verified in ~/dev/yeet: Cargo.toml has no `schemars` dep; no `JsonSchema` derive on RunSpec/Event; no `yeet schema` subcommand in src/cli.rs. RunSpec = src/spec.rs, Event = src/event.rs (paths in ticket correct). Both ACs unmet. Keep To Do.

<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->

## created: 2026-07-07 09:47

## Superseded by ENG-9 (shipped in engine): schemars JSON Schema for RunSpec+Event, published as generated TS types. Closed as ENG-duplicate during ENG-6 migration, not migrated.

<!-- COMMENTS:END -->

## Definition of Done

<!-- DOD:BEGIN -->

- [ ] #1 Run feature-implementation workflow in order
- [ ] #2 cargo test + cargo clippy -D warnings + the schema snapshot test run fresh, output recorded
<!-- DOD:END -->
