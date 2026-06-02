---
name: quality-gate
description: Use when writing, reviewing, or verifying code to reject bandaids, unsafe casts/assertions, massive branching, type-system escapes, shallow abstractions, dead code, duplicated logic, and other code smells. Forces proper data flow, real validation, maintained library/tool use, small cohesive modules, and root-cause fixes before code is considered acceptable.
---

# Quality Gate

This is the smell gate. It exists because "it works" is not enough: workarounds, casts, assertions, giant branches, and shallow glue make code harder to change and easier to break. If a change trips this gate, fix the design or stop and escalate. Do not ship the smell and promise cleanup later.

## The rule

**No bandaids. No type-system escapes. No massive branching. No smell accepted as "good enough."**

There are only two valid outcomes:

1. **Remove the smell properly** with a root-cause change, better data flow, a deeper module, a maintained library, or a framework/tool-supported path.
2. **Stop and surface the real fix** if removing it requires a larger design decision, migration, or upstream change.

Do not hide a defect behind a workaround, unsafe cast, non-null assertion, feature flag, fallback default, swallowed error, broad condition, or "temporary" branch.

## Decision Order

Before adding code:

1. **Use the real type/data flow.** Model states explicitly. Validate unknown data at boundaries. Pass correct types through the system.
2. **Use the existing library/framework/tool.** Do not rebuild parsing, validation, routing, migrations, retries, state machines, formatting, auth, or codegen locally.
3. **Choose the right seam.** Put behaviour behind a deep module with a simple interface; do not smear logic across callers.
4. **Cut the branch count.** Prefer polymorphism, strategy maps, discriminated unions, lookup tables, pipelines, small guard clauses, and exhaustive handlers over sprawling `if/else` or `switch` blocks.
5. **Prove it.** Add behaviour tests at the public seam, then run the relevant static checks and tests.

## Hard Rejects

These are blocking unless the user explicitly accepts the named trade-off after seeing the real fix:

- **Workarounds and bandaids:** defensive defaults that mask bad state, retries that hide ordering bugs, sleeps for races, broad `catch` blocks, feature flags used to avoid fixing logic, TODO/FIXME "temporary" patches, compatibility shims with no migration plan.
- **Unsafe type escapes:** `as any`, `as unknown as T`, unchecked downcasts, non-null assertions (`!`), definite-assignment assertions used to dodge initialization, `@ts-ignore`, `@ts-expect-error` without a linked reason, raw `any`, unsafe member access/calls/returns from `any`.
- **Assertions that silence tools:** compile-time type assertions, null assertions, blanket casts, test-only mocks cast into production types, and production `assert(...)` calls used instead of proper setup or validation. Use explicit validation/type guards at boundaries and construction-time invariants instead.
- **Massive branching:** long `if/else if` ladders, repeated `switch`/case logic, nested conditionals, mode flags that create many hidden behaviours, boolean parameter matrices, duplicated permission/status/type checks.
- **Broken data flow:** invalid states representable in types, nullable values pushed deep into logic instead of handled at boundaries, primitive obsession for domain concepts, stringly typed enums/statuses, parallel arrays, data clumps, mutation shared across layers.
- **Shallow architecture:** pass-through wrappers, middlemen, manager/helper/utils dumping grounds, feature envy, message chains, leaky abstractions, circular dependencies, hidden globals, shotgun surgery, divergent change.
- **Bloat and duplication:** long methods, large classes/files, long parameter lists, repeated condition clusters, copy-pasted tests or logic, speculative generality, unused abstractions, dead code.
- **Error-handling smells:** swallowed errors, catch-all fallbacks, logs instead of recovery, exceptions used for normal control flow, missing cancellation/timeouts, partial writes without rollback/compensation.
- **Test smells:** tests that assert implementation details, over-mocking, snapshots that bless accidental output, tests that require unsafe casts, skipped/flaky tests, coverage without behavioural value.
- **Tooling bypasses:** manual migrations/scaffolds/codegen where an official CLI exists, generated files edited without understanding regeneration, disabled lint/type checks, ignored static-analysis findings without a concrete reason.

## Proper Replacements

Use these moves instead of the smell:

- Replace unsafe casts with runtime validation, parser/schema libraries, type guards, discriminated unions, generated types, generic constraints, or corrected function signatures.
- Replace non-null assertions with earlier null handling, explicit loading/error states, constructor/setup invariants, guard clauses, or APIs that cannot return absent values for required paths.
- Replace giant branches with a table of handlers, command/strategy objects, polymorphism, exhaustive discriminated-union matching, state machines, or a deep domain service.
- Replace workaround defaults with explicit error states and caller-visible contracts.
- Replace duplicated condition clusters with one named policy function/module that owns the decision.
- Replace primitive obsession with value objects, branded/nominal types, enums/unions, schema-validated records, or domain-specific constructors.
- Replace shallow helpers with a deeper module that owns the behaviour and exposes a small interface.
- Replace manual setup with official generators, migrations, codemods, codegen, package scripts, or repo-local wrappers.

## Review Checklist

During implementation or review, ask:

- Can I delete any cast/assertion and still have the compiler understand the code? If not, is the type/data flow wrong?
- Is every value from I/O, network, storage, config, URL params, user input, or generated data validated before use?
- Is this branch structure small enough to reason about in one read? If not, what concept should own the variation?
- Does this change make invalid states impossible, or merely hope they do not happen?
- Would another caller reintroduce the bug by following the current interface? If yes, the interface is the bug.
- Does this module buy behaviour for little caller knowledge, or is it a pass-through wrapper?
- Did any lint/type/test suppression appear? If yes, why is the proper fix not possible?
- Did any generated/mechanical file get hand-written? If yes, what CLI was checked?

## Evidence

Acceptable evidence depends on the repo, but use what exists:

- Strict typecheck (`tsc --noEmit`, `pyright`, `mypy`, `go test`, `cargo check`, etc.).
- Lint/static analysis with unsafe-cast, complexity, max-depth, max-lines/function, no-explicit-any, no-non-null-assertion, and no-unsafe-* rules where available.
- Focused behaviour tests proving the public seam.
- A diff review showing no suppressions, unsafe casts/assertions, large branch ladders, dead code, accidental generated churn, or workaround comments.

If the repo lacks tool enforcement, do a manual gate and report that it was manual.

## The short version

If a change needs a cast, assertion, workaround, huge branch, duplicate condition cluster, shallow wrapper, or disabled tool to pass, the design is not done. Fix the data flow, interface, module boundary, or tool-supported setup. If the proper fix is bigger than the task, stop and say that.

---

*Original skill for Oisin's skills repo. Code-smell taxonomy informed by Fowler/Beck-derived catalogs and Refactoring.Guru; complexity gates informed by ESLint cyclomatic-complexity and nesting rules plus Sonar Cognitive Complexity; TypeScript safety guidance informed by the TypeScript handbook, typescript-eslint no-unsafe/no-assertion rules, and Google TypeScript style guidance.*
