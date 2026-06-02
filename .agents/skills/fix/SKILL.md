---
name: fix
description: Use when authoring, proposing, or reviewing ANY fix, patch, or workaround — or deciding whether to ship or defer. Forbids bandaids and symptom-patches — the fix addresses the root cause, or you stop and escalate. Trigger on "fix this", "is that a proper fix", "just patch it", "good enough for now", "add a workaround", "ship it", and whenever you're about to call something fixed.
---

# Root-Cause Fixes

A fix either removes the cause or it hides the symptom. This skill exists so that you only ever ship the first kind — and so the human never has to stop you and ask "is that actually a proper fix?", because that question is already answered before you write a line.

## The rule

**The root-cause fix is the only default. There is no acceptable bandaid.**

Two outcomes are allowed, and only two:

1. **Fix the root cause properly** — the real fix, in proper code.
2. **If the proper fix is genuinely infeasible right now** (it needs a large refactor, a design decision, an upstream change), **STOP.** Surface what you found, name the real fix and its honest cost, and let your human partner decide whether to defer. *They* make that call — you don't make it for them by quietly shipping a workaround.

What you must never do: silently apply a patch/workaround and present it as done. "Technically the problem goes away" is not the bar. Errors only grow — a bandaid leaks into the surrounding code, and the next person inherits both the original defect and the workaround obscuring it.

Also forbidden: making the compiler, linter, or test suite shut up without fixing the data flow. Unsafe casts, type assertions, non-null assertions, broad fallbacks, sleeps, retries, swallowed errors, disabled checks, and giant branches are workarounds unless they remove the actual cause. Use [[quality-gate]] when reviewing the proposed fix.

## Before you write the fix: walk the ladder

You should already know the root cause (via [[trace]]). Confirm where the fix belongs:

1. **Symptom.** State the user-visible fault precisely — the symptom, not your guess at the cause.
2. **Proximate cause.** Which exact code is wrong — and is the defect at the line you'd patch, or upstream of it? The line that *fires* the error is rarely the line that *contains* it.
3. **Contract.** Is the abstraction itself misleading — would another developer, following normal patterns, re-trigger this same bug at a different call site? If yes, the defect is in the interface, fix it there.
4. **Isolated or systemic.** One-off oversight, or one face of a broader pathology? If it's systemic, scope the fix to the broader cause — patching one of N just files the other N−1 as future bugs.

## "But the real fix is expensive"

The cost of the refactor is almost always *estimated*, not *measured* — and the estimate is usually inflated by the fact that the bandaid feels closer. A thirty-minute look at the cause routinely shows the proper fix is cheaper than the long tail of the workaround it would replace. Downgrading to a bandaid because the refactor *felt* big — and writing it up as if the bandaid were the only option — is not engineering. Deferring *after* investigating, with the reasoning written down, is.

## Untestable code raises the bar, it doesn't lower it

If a defect can't be covered by a test (timing, render-order, layered composition where execution order *is* the behaviour), it ships with **no defence**. That means *more* skepticism, not less. The wrong inference is "we can't test it, so any fix will do." The right one is the opposite. Prefer the underlying fix; if you genuinely must make a surgical change, document the constraint at the call site so the next reader sees both the fault and the rule that keeps it from recurring.

## Done means proven, not "should work"

A fix is not "fixed" until you have *watched* it work:

- Write/keep a test that reproduces the original symptom. Confirm it **fails** before the fix and **passes** after (red→green — a test that only ever passes proves nothing).
- Reproduce the original symptom by the original steps and confirm it is actually gone.
- Run the full suite — no new failures.

No "should work", "probably fixed", "that ought to do it". If you haven't run it and read the output this session, you haven't verified it — say what you actually know.

## The short version

- Root-cause fix, or stop and escalate. No third option.
- Walk the ladder: symptom → proximate cause → contract → isolated vs systemic.
- "Expensive" is usually a guess; investigate before you believe it.
- Untestable ⇒ more skepticism.
- "Fixed" requires reproduced-then-gone + green tests you actually ran.

---

*Anti-bandaid framing adapted from [gridaco/grida](https://github.com/gridaco/grida) `etiology` (Apache-2.0), with its "acceptable bandaid" carve-out deliberately removed; verification gate adapted from [obra/superpowers](https://github.com/obra/superpowers) `verification-before-completion` (MIT). Pairs with [[trace]], [[quality-gate]], [[verify]], and [[secure]] for CVE/security remediation.*
