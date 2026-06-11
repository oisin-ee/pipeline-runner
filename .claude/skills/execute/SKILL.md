---
name: execute
description: "Use when carrying an approved ticket, issue, plan slice, or direct implementation request through to working code. Orchestrates disciplined execution: classifies the work, routes to the right specialist skills, enforces their order, checks fidelity, and hands off to review and verification. Does not replace [[test]], [[verify]], [[critique]], or any other specialist skill — it chooses them, sequences them, and refuses to skip them."
---

# Execute

Execute is the runtime controller. It takes an approved ticket, a plan slice, or a direct user request and drives it through the right specialist skills in the right order. It does not own the doctrine — [[test]], [[fix]], [[verify]], [[critique]], and the others own that. Execute owns the dispatch, the sequence, the fidelity check, and the finish.

Use this skill when the user hands you a ticket, issue, plan item, or direct implementation request and expects you to build it.

## The rule

**Route first, then build. Do not write code until the request has been classified and the required companion skills have been loaded.**

Do not batch the work horizontally: no "models first, then API, then UI, then tests." A completed increment should be small, coherent, and runnable: one observable behaviour, through the real public interface, with the tests and verification that prove it.

## Phase 0 — Route to the right skills

Execute is an orchestrator. Decide what kind of work this is, then load only the skills that apply:

- **Bug, failing test, flaky behaviour, regression** — run [[trace]] or [[diagnose]] before writing a fix, then [[fix]].
- **New behaviour, feature, or direct implementation request** — run [[test]] and keep the red-green-refactor loop vertical.
- **Unclear request or no honest done-condition** — run [[spec]] or [[scope]] before coding. Do not improvise requirements from a vague ask.
- **Unfamiliar API, library, version, tool, or technical claim** — run [[research]] from primary sources. Training-data recall is not a source.
- **About to hand-roll parsing, dates, auth, retries, validation, state machines, queues, crypto, file formats, scaffolding, migrations, generated code, or similar** — run [[library-first-development]] first.
- **User input, auth, data storage, secrets, permissions, external integrations** — run [[secure]].
- **Performance-sensitive path or suspected regression** — run [[optimize]].
- **Change strains module boundaries or has no honest test seam** — run [[improve]] before forcing code into the wrong shape.
- **Non-trivial decision whose correctness matters** — run [[doubt]] before committing to it.
- **Before declaring completion** — run [[critique]] and [[verify]].

If a companion skill applies, follow it. Do not replace it with a summary from memory.

## Ordering rules

The order between companion skills is not optional:

1. Never [[fix]] before [[trace]] / [[diagnose]].
2. Never write production behaviour before [[test]].
3. Never rely on memory instead of [[research]] for unfamiliar or version-specific APIs.
4. Never run code-quality review before checking spec/request compliance.
5. Never claim completion before [[verify]].

These rules exist because the skills assume each other. Skipping the order skips the protection.

## Phase 0.5 — Library-driven, CLI-first

Before writing production code, ask these in order:

1. **Is there already a project library/framework feature for this?** Use the existing dependency, adapter, ORM, router, validator, generator, formatter, or test helper before creating a local version.
2. **Is there an official CLI that mechanically creates or updates these files?** For scaffolding, migrations, models, controllers, routes, clients, SDKs, config, snapshots, locks, generated types, or boilerplate, prefer the framework's CLI/generator over hand-created files.
3. **Can the CLI be inspected safely first?** Run `--help`, dry-run/pretend/create-only options, or generate into a scratch path when supported. Check the diff before keeping generated output.
4. **If no library or CLI fits, why not?** Write the reason in the handoff or code review notes before hand-writing the replacement.
5. **Is copy-paste involved?** If you are about to transplant code from a web page, LLM output, Stack Overflow answer, another file in the project, or any other source — stop. Read it, understand every line and its edge cases, then write it yourself for the current context. Mechanical boilerplate from the project's own CLI/generator (question 2) is the only exception.

CLI-first does not mean blindly accepting generated code. It means the framework's mechanical path is the default starting point, then you trim, review, and test the result like any other change.

## Phase 1 — Understand the work

Normalise whatever you were given — a ticket, a plan slice, or a direct request — into a working contract. Read before editing:

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
- Delegated skills required:
- Library/CLI/generator decision:
- Risks or unknowns:
```

If there is no existing ticket, the contract *is* the ticket. Make it concrete enough that someone reading it cold could implement it. If you cannot fill this in honestly, do not improvise. Research, inspect, or ask one focused question.

## Phase 2 — Choose the seam

Pick the public interface where the behaviour should be proven. Good seams are user-facing or caller-facing: an endpoint, command, component contract, service method, CLI output, state transition, or file format.

Before writing tests or code, check the architecture:

- Is the new behaviour naturally behind an existing deep module?
- Will callers get a simple interface with substantial behaviour behind it?
- Are you about to create shallow pass-through wrappers or scatter conditionals across callers?
- Would the test survive an internal refactor?
- Is there a real seam, or are you extracting functions only because the current design is hard to test?

If the correct seam is missing, create or deepen it as part of the slice, but keep the slice small. If creating the seam is larger than the requested change, stop and escalate. If the seam is unclear because the request itself is unclear, return to Phase 0 and route to [[spec]] / [[scope]].

## Phase 3 — Execute in vertical TDD cycles

For each behaviour:

1. **RED** — Write one test through the public interface. Watch it fail for the expected reason. The detailed TDD discipline lives in [[test]].
2. **GREEN** — Use the relevant library or CLI/generator first when it owns the boilerplate, then write the minimum production code that makes that test pass. No speculative branches.
3. **REFLECT** — Re-read the code for naming, locality, error handling, security boundaries, fit with existing patterns, and [[quality-gate]] smells.
4. **REFACTOR** — Clean up only while green. Deepen modules where the new code reveals shallow structure.
5. **FIDELITY CHECK** — Re-read the original request or ticket. Did we build what was actually asked for? Did we stay within the declared slice? Did we use the named library/CLI/tooling path, or consciously deviate? If scope crept silently, cut it or escalate.
6. **VERIFY THE INCREMENT** — Run the focused test/check again and read the output.

Then move to the next behaviour. Every cycle should leave the repo closer to shippable than before.

## Phase 4 — Review the result

Inspect the diff before running broad checks. The order matters: compliance first, quality second.

### Gate 1 — Spec / request compliance

- Does the code match what was asked? Check the original request or ticket line by line.
- Are there missing requirements the implementer claimed to have delivered?
- Is there extra work that was not requested?
- Did the named library, CLI, or tooling path get used? If not, was the deviation intentional?

If compliance fails, fix it. Do not proceed to Gate 2.

### Gate 2 — Code quality

Only after Gate 1 passes:

- **Architecture:** complexity is concentrated behind simple interfaces; no shallow wrappers, duplicated condition clusters, hidden shared state, or leaked internals.
- **Security:** untrusted input is validated at boundaries; authorization and secrets are handled deliberately; no sensitive logging.
- **Performance:** no obvious N+1s, unbounded reads, hot-path waste, or avoidable synchronous work.
- **Maintainability:** names match project vocabulary; code follows local patterns; dead code and debug instrumentation are removed; no code copied from external sources or duplicated internally without extraction.
- **Library/CLI:** generated or mechanical files came from the official project tooling when available; any manual replacement has a written reason; every library API used is verified against the installed version's documentation.
- **Quality gate:** no workarounds, unsafe casts/assertions, type-system escapes, huge branch ladders, shallow wrappers, duplicated condition clusters, or disabled checks.

If a gate fails, fix it with the same vertical discipline. Do not hide known issues behind "tests pass."

## Escalate instead of thrashing

Stop and surface the problem when:

- The request is materially unclear and cannot be resolved by a focused question.
- The plan or ticket is missing critical information that blocks implementation.
- Implementation reveals a missing architectural decision that exceeds the scope of the change.
- The same approach has failed repeatedly and is just being retried.
- Verification cannot honestly support the intended claim.

Do not keep looping. Do not guess. Stop, say what is happening, and ask.

## Phase 5 — Complete the work

Before claiming done:

1. Re-read the original request or ticket and check fidelity one final time.
2. Run the focused tests for the touched behaviour.
3. Run the broader project checks appropriate to the change: test suite, typecheck, lint, build, e2e, manual browser/CLI flow, migration dry-run, or benchmark.
4. Inspect `git diff` for accidental edits, debug logs, secrets, generated churn, and unrelated changes.
5. Run [[quality-gate]] on the finished diff.
6. Run [[critique]] on the finished diff.
7. Run [[verify]] and report the actual commands and results.

If verification is partial, say exactly what is verified and what is not. Work is not complete because code exists — work is complete when the specialist skills say it is.

## Red flags

- Starting implementation before reading the existing code path.
- Treating a direct request as permission to invent requirements.
- Hand-writing framework boilerplate, migrations, generated clients, or config before checking the official CLI/generator.
- Building a local helper for a capability already provided by the project's libraries.
- Writing several tests before making the first one pass.
- Adding production code for a behaviour that has no failing test yet.
- Testing private methods because the public seam is inconvenient.
- Creating a pass-through abstraction and calling it architecture.
- Adding a workaround, cast, assertion, broad fallback, lint/type suppression, or giant branch to make the error go away.
- Copy-pasting code from the internet, another part of the project, an LLM, or any source without understanding it and writing it for the current context.
- Refactoring while red.
- Shipping a workaround for a bug whose cause is not understood.
- Hand-rolling a standard hard problem without a build-vs-adopt and CLI/generator check.
- Ignoring security because the feature is "internal."
- Claiming done without fresh command output from this session.
- Running code-quality review before checking spec/request compliance.
- Retrying the same failed approach without changing anything or escalating.
- Bypassing a delegated skill because "it seemed obvious."

## The short version

Intake direct request or approved slice — route to the right specialist skills — enforce required order — build one behaviour at a time with [[test]] — check fidelity against the original ask — review spec compliance first, code quality second — escalate instead of thrashing — finish through [[critique]] then [[verify]]. Execution is complete only when the evidence supports the claim.

---

*Execute is the runtime orchestrator for Oisin's skills repo. It composes [[trace]], [[diagnose]], [[fix]], [[test]], [[research]], [[library-first-development]], [[secure]], [[optimize]], [[improve]], [[quality-gate]], [[doubt]], [[critique]], and [[verify]] — choosing them, sequencing them, and refusing to skip them. The vertical-slice and architecture stance is informed by [mattpocock/skills](https://github.com/mattpocock/skills) engineering skills (MIT, © 2026 Matt Pocock), with the orchestration model informed by [obra/superpowers](https://github.com/obra/superpowers) subagent-driven-development reviewing discipline and routing from Anthropic and Vercel skill ecosystem patterns.*
