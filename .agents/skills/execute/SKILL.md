---
name: execute
description: "Use when carrying an approved ticket, issue, plan slice, or implementation request through to working code. Orchestrates disciplined execution: read the real context, prefer library-driven and CLI-first implementation, use TDD red-green-refactor in vertical slices, reject workarounds/casts/assertions/code smells, preserve architecture with deep modules and clean seams, apply security/performance/research gates when relevant, review the diff, and verify before claiming completion."
---

# Execute

Execution means taking a scoped change all the way to a verified result. This is not "write a lot of code, then see what happens." It is a tight engineering loop: understand the slice, use the project's existing libraries and CLIs before hand-writing code, reject bandaids and code smells, prove each behaviour with TDD, keep the design healthy as the code appears, review the result, and report only evidence.

Use this skill when the user hands you a ticket, issue, plan item, acceptance criteria, or direct implementation request and expects you to build it.

## The rule

**One vertical behaviour at a time, verified end to end.**

Do not batch the work horizontally: no "models first, then API, then UI, then tests." A completed increment should be small, coherent, and runnable: one observable behaviour, through the real public interface, with the tests and verification that prove it.

## Phase 0 - Load the right companion skills

Execution is an orchestrator. Load the other skill only when its trigger applies:

- **Bug, failing test, flaky behaviour, regression** -> run [[trace]] or [[diagnose]] before writing a fix, then [[fix]].
- **Non-trivial behaviour change** -> run [[test]] and keep the red-green-refactor loop vertical.
- **Unfamiliar API, library, version, tool, or technical claim** -> run [[research]] from primary sources.
- **About to hand-roll parsing, dates, auth, retries, validation, state machines, queues, crypto, file formats, scaffolding, migrations, generated code, or similar** -> run [[library-first-development]] first.
- **User input, auth, data storage, secrets, permissions, external integrations** -> run [[secure]].
- **Performance-sensitive path or suspected regression** -> run [[optimize]].
- **Unclear requirements or no acceptance criteria** -> run [[spec]] or [[scope]] before coding.
- **Change strains module boundaries or has no honest test seam** -> run [[improve]] before forcing code into the wrong shape.
- **Writing or reviewing production code** -> run [[quality-gate]] to reject workarounds, unsafe casts/assertions, massive branching, shallow wrappers, and other smells.
- **Non-trivial decision whose correctness matters** -> run [[doubt]] before committing to it.
- **Before declaring completion** -> run [[critique]] and [[verify]].

If a companion skill applies, follow it. Do not replace it with a summary from memory.

## Phase 0.5 - Library-driven, CLI-first

Before writing production code, ask these in order:

1. **Is there already a project library/framework feature for this?** Use the existing dependency, adapter, ORM, router, validator, generator, formatter, or test helper before creating a local version.
2. **Is there an official CLI that mechanically creates or updates these files?** For scaffolding, migrations, models, controllers, routes, clients, SDKs, config, snapshots, locks, generated types, or boilerplate, prefer the framework's CLI/generator over hand-created files.
3. **Can the CLI be inspected safely first?** Run `--help`, dry-run/pretend/create-only options, or generate into a scratch path when supported. Check the diff before keeping generated output.
4. **If no library or CLI fits, why not?** Write the reason in the handoff or code review notes before hand-writing the replacement.

CLI-first does not mean blindly accepting generated code. It means the framework's mechanical path is the default starting point, then you trim, review, and test the result like any other change.

## Phase 1 - Understand the slice

Read before editing:

1. The request, ticket, issue, or acceptance criteria.
2. The relevant rules file (`AGENTS.md`, `CLAUDE.md`, local docs).
3. Existing code paths and tests around the behaviour.
4. Dependency files and framework versions when APIs matter.
5. Domain glossary / ADRs when present, so names and decisions match the project.

State the execution contract in your own words:

```text
Contract:
- Behaviour to deliver:
- Public interface / user-visible path:
- Acceptance criteria:
- Files or modules likely involved:
- Relevant tests/checks:
- Library/CLI/generator decision:
- Quality-gate risks:
- Risks or unknowns:
```

If you cannot fill this in honestly, do not improvise. Research, inspect, or ask one focused question.

## Phase 2 - Choose the seam

Pick the public interface where the behaviour should be proven. Good seams are user-facing or caller-facing: an endpoint, command, component contract, service method, CLI output, state transition, or file format.

Before writing tests or code, check the architecture:

- Is the new behaviour naturally behind an existing deep module?
- Will callers get a simple interface with substantial behaviour behind it?
- Are you about to create shallow pass-through wrappers or scatter conditionals across callers?
- Would the test survive an internal refactor?
- Is there a real seam, or are you extracting functions only because the current design is hard to test?

If the correct seam is missing, create or deepen it as part of the slice, but keep the slice small. If creating the seam is larger than the requested change, stop and surface that as an architecture finding.

## Phase 3 - Execute in vertical TDD cycles

For each behaviour:

1. **RED** - Write one test through the public interface. Watch it fail for the expected reason.
2. **GREEN** - Use the relevant library or CLI/generator first when it owns the boilerplate, then write the minimum production code that makes that test pass. No speculative branches.
3. **REFLECT** - Re-read the code for naming, locality, error handling, security boundaries, fit with existing patterns, and [[quality-gate]] smells.
4. **REFACTOR** - Clean up only while green. Deepen modules where the new code reveals shallow structure.
5. **VERIFY THE INCREMENT** - Run the focused test/check again and read the output.

Then move to the next behaviour. Every cycle should leave the repo closer to shippable than before.

## Phase 4 - Code quality gates

After the behaviours are implemented, inspect the diff before running broad checks:

- **Correctness:** acceptance criteria are directly covered; edge cases and error paths are intentional.
- **Tests:** tests describe behaviour, not private implementation; no over-mocking; bug fixes have regression coverage at the right seam.
- **Architecture:** complexity is concentrated behind simple interfaces; no shallow wrappers, duplicated condition clusters, hidden shared state, or leaked internals.
- **Security:** untrusted input is validated at boundaries; authorization and secrets are handled deliberately; no sensitive logging.
- **Performance:** no obvious N+1s, unbounded reads, hot-path waste, or avoidable synchronous work.
- **Maintainability:** names match project vocabulary; code follows local patterns; dead code and debug instrumentation are removed.
- **Library/CLI:** generated or mechanical files came from the official project tooling when available; any manual replacement has a written reason.
- **Quality gate:** no workarounds, unsafe casts/assertions, type-system escapes, huge branch ladders, shallow wrappers, duplicated condition clusters, or disabled checks.

If a gate fails, fix it with the same vertical discipline. Do not hide known issues behind "tests pass."

## Phase 5 - Verify completion

Before claiming done:

1. Re-read the original acceptance criteria and check each one.
2. Run the focused tests for the touched behaviour.
3. Run the broader project checks appropriate to the change: test suite, typecheck, lint, build, e2e, manual browser/CLI flow, migration dry-run, or benchmark.
4. Inspect `git diff` for accidental edits, debug logs, secrets, generated churn, and unrelated changes.
5. Apply [[quality-gate]] to the finished diff.
6. Apply [[critique]] to the finished diff.
7. Apply [[verify]] and report the actual commands/results.

If verification is partial, say exactly what is verified and what is not.

## Red flags

- Starting implementation before reading the existing code path.
- Hand-writing framework boilerplate, migrations, generated clients, or config before checking the official CLI/generator.
- Building a local helper for a capability already provided by the project's libraries.
- Writing several tests before making the first one pass.
- Adding production code for a behaviour that has no failing test yet.
- Testing private methods because the public seam is inconvenient.
- Creating a pass-through abstraction and calling it architecture.
- Adding a workaround, cast, assertion, broad fallback, lint/type suppression, or giant branch to make the error go away.
- Refactoring while red.
- Shipping a workaround for a bug whose cause is not understood.
- Hand-rolling a standard hard problem without a build-vs-adopt and CLI/generator check.
- Ignoring security because the feature is "internal."
- Claiming done without fresh command output from this session.

## The short version

Read the real context -> choose existing libraries and official CLI/generators before manual code -> choose the public seam -> one behaviour at a time with red-green-refactor -> keep modules deep and changes local -> reject workarounds/casts/assertions/smells with [[quality-gate]] -> run security/research/performance gates when relevant -> review the diff -> verify with fresh evidence. Execution is complete only when the acceptance criteria are met and the evidence supports the claim.

---

*Original orchestration skill for Oisin's skills repo. It composes the local [[test]], [[diagnose]], [[fix]], [[research]], [[library-first-development]], [[improve]], [[quality-gate]], [[secure]], [[optimize]], [[critique]], [[doubt]], and [[verify]] skills, with the vertical-slice and architecture stance informed by [mattpocock/skills](https://github.com/mattpocock/skills) engineering skills (MIT, © 2026 Matt Pocock).*
