---
name: test
description: Use when implementing any non-trivial feature, behaviour, or bug fix — write the failing test first, in vertical tracer-bullet slices, one test → one implementation at a time. Tests verify behaviour through public interfaces, never implementation details. Trigger on "build X", "implement X", "fix this bug", "add a feature", "red-green-refactor", "write tests", and any behaviour change that isn't config/docs/rename.
---

# Test-Driven Development

Write the test that fails, then the code that makes it pass, then clean up — one behaviour at a time. The test comes first because a test written *after* the code tests the code you wrote, not the behaviour you wanted; and because a test you've never watched fail proves nothing. TDD is the default for feature work and bug fixes. Skip it only when there's no behaviour to test: config, copy, a rename, a pure-formatting change.

## Tests verify behaviour, not implementation

A good test exercises real code paths through the public interface and reads like a specification — "user can check out with a valid cart". It survives refactors because it doesn't know or care how the code is structured inside. A bad test reaches into the internals: mocks collaborators it shouldn't, asserts on private methods, checks *which functions were called* instead of *what came out*. The tell: you rename an internal function or restructure a module and tests go red while behaviour is unchanged. That test was testing the implementation. Delete or rewrite it.

Assert on **state and outputs**, not interactions. Prefer **real implementations > fakes > stubs > mocks**, in that order — mock only at boundaries that are slow, non-deterministic, or have side effects you can't control (network, email, the clock). Over-mocking buys a suite that's green while production is on fire.

## Readable tests beat clever tests

Prefer DAMP tests over DRY tests: descriptive and meaningful phrases are better than a clever helper that hides the behaviour under test. Duplication in test setup is fine when it makes each test read as its own specification. Extract only when the helper's name makes the behaviour clearer, not merely shorter.

## The anti-pattern: horizontal slices

**Do not write all the tests, then all the code.** Treating RED as "write every test" and GREEN as "write every implementation" produces tests for *imagined* behaviour — you commit to the shape of things before you understand them, and the tests end up insensitive to the changes that matter.

```
WRONG (horizontal):  test1 test2 test3  →  impl1 impl2 impl3
RIGHT (vertical):     test1 → impl1 → test2 → impl2 → test3 → impl3
```

Go vertical. Each cycle teaches you what the next test should be.

## The loop

1. **Plan the behaviours.** Decide the public interface and *which behaviours matter most* — you can't test everything, so test the critical paths and the complex logic, not every trivial getter. (In a larger effort this list comes out of [[scope]].)
2. **Tracer bullet.** Write ONE test for ONE behaviour. Watch it fail (RED) — if it passes immediately, it isn't testing what you think. Write the minimum code to pass (GREEN).
3. **Incremental loop.** For each remaining behaviour: one test → watch it fail → minimum code to pass. One at a time. Don't write code for a test you haven't written yet.
4. **Refactor — but only on GREEN.** With the suite passing, remove duplication and deepen modules (push complexity behind simple interfaces — see [[improve]]). Run the tests after each step. **Never refactor while RED** — get to green first, then clean.

For multi-file work, keep each increment as a thin vertical slice that leaves the system working: implement the smallest complete behaviour, run the relevant tests/build, verify it manually if needed, then move to the next slice. If you are about to write a large batch of code before running anything, stop and cut a smaller slice.

## Bug fixes: reproduce before you fix

A bug fix *starts* with a failing test, not a fix. Write a test that reproduces the bug and watch it fail — that's your proof the bug is real and that you're aiming at the right thing. Then fix it and watch the test go green. This is the same red→green evidence [[fix]] demands, and it's how [[diagnose]] turns a minimised repro into a permanent regression guard. If there's no honest seam to write that test at, that absence is itself a finding — say so, don't fake a shallow test that passes for the wrong reason.

## Per-cycle checklist

- [ ] The test describes a behaviour, through the public interface only.
- [ ] You watched it fail before making it pass.
- [ ] The code is the minimum for *this* test — no speculative features.
- [ ] The test would survive an internal refactor.

## Red flags

- A test that passed the first time you ran it (you never saw RED).
- "All tests pass" with no test-command output in front of you.
- A bug fix with no reproduction test.
- Tests that break on rename/refactor though behaviour didn't change.
- Mocking everything; asserting on call sequences instead of outcomes.
- Writing ten tests before writing any code.
- Writing the test after the fix and calling it proof.
- Extracting test helpers until the behaviour is hidden.

## The short version

One behaviour at a time: red → green → refactor, vertically. Test through the public interface, assert on outputs, prefer real code over mocks. Watch every test fail before it passes. Bug fixes begin with a reproduction test. Never refactor on red.

---

*Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) `tdd` (MIT, © 2026 Matt Pocock), with incremental-implementation guidance folded in from local oisin-pipeline material. Pairs with [[scope]] (which behaviours to test), [[fix]] and [[diagnose]] (reproduction-test-first), [[verify]] (evidence before claims), and [[improve]] (the refactor step).*
