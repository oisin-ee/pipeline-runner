---
name: trace
description: Use when investigating ANY bug, test failure, crash, hang, flaky test, or unexpected/"weird" behaviour — BEFORE proposing or writing a fix. Forces finding the real root cause instead of guessing, patching the first thing you see, or fixing the symptom. Trigger on "why is this broken", "this is acting weird", "debug this", "the test fails", "it works sometimes".
---

# Systematic Debugging

Guessing wastes time and ships new bugs. The first explanation that comes to mind is usually the symptom, not the cause. This skill is the investigation discipline you run before you are allowed to touch a fix.

## The one rule

**No fix until you have found the root cause. Finding the cause is a separate step from fixing it, and it comes first.**

If you have not finished Phase 2, you do not get to propose a fix. Not "probably", not "let me just try", not "this should do it". Find the cause, then go to [[fix]] to fix it properly.

Run this even when — *especially* when — the bug looks trivial, you are in a hurry, or someone wants it fixed now. Simple bugs have root causes too, and systematic is faster than thrashing through five guesses.

## What is a root cause?

A root cause is not just the line that fails or the first upstream mistake you find. It is the **earliest point in the system where a change would prevent the entire class of bug, not just this one instance.** If fixing that point would still let the same kind of defect appear through a different path, you are not at the root cause yet.

Ask yourself:

- **What?** What exactly happened, step by step?
- **Why?** Why did each step occur — why was the bad value accepted, why was the contract not enforced, why was the assumption wrong?
- **Why not prevented?** What guard, validation, invariant, or test should have caught this but did not?

You are at the root cause when you can answer all three, and the fix at that point closes the defect path for every caller, not just the one that triggered the bug.

If you can only answer "what" — you have a symptom and need to keep digging. If you can answer "what" and "why" but not "why not prevented" — you have a proximate cause but the system's defences are still broken. Go deeper.

## Phase 1 — Reconstruct the incident

Before forming any hypotheses, gather the facts:

1. **Understand the intended behavior.** What should have happened? Read the spec, the test expectations, the docstring, the commit message that introduced the code. You cannot diagnose a deviation from correct behavior if you do not know what correct is. Mistaking intended behavior for a bug is the most expensive debugging error.
2. **Read the actual error.** All of it — full message, full stack trace, error codes, line numbers. The answer is often sitting in text you skimmed past.
3. **Reproduce it reliably.** Exact steps. Does it happen every time? On every environment? With every input shape? If you cannot reproduce it, you cannot prove you fixed it — gather more data, do not guess. For intermittent bugs, raise the reproduction rate (loop 100×, parallelise, add stress, narrow timing windows) until it is debuggable.
4. **Check what changed.** `git diff`, recent commits, `git log --since`, new deps, config/env differences, data migrations, infra changes. Most bugs ride in on a recent change. If you do not know what changed, `git bisect` between a known-good and known-bad revision.
5. **Compare against what works.** Find similar code or scenarios that produce correct output. Read every line — do not skim. List every difference between the working and broken paths, however small ("that can not matter" is how you miss it). Understand the dependencies, config, and assumptions the working path relies on. If nothing similar exists, find the last known-good version and diff it.
6. **Instrument the boundaries** (multi-component systems — request → service → DB, CI → build → sign). Log what data enters and exits each component. Run once to see *which* layer breaks before you go spelunking in the wrong one.

## Phase 2 — Find the root cause

With the incident reconstructed, trace the mechanism from symptom to origin. Use every technique that applies — a single approach applied by rote misses whole categories of bug.

### Backward tracing (data-flow bugs)

Bugs that manifest as wrong output, wrong state, or wrong values:

1. Observe the symptom — what failed, exactly?
2. Find the immediate cause — what line directly produces it?
3. Ask "what called this, and with what value?" — go one level up.
4. Keep going up until you find where the bad value/state was actually **created**, not just propagated.
5. At that creation point, ask: was the value legal but wrong (logic error), or illegal and unvalidated (missing guard)?

When you cannot trace by reading, add instrumentation — dump the value, the `cwd`/env, and `new Error().stack` right before the failing operation, run, and read the output. Use `console.error` (loggers can swallow output in tests). Rip the instrumentation out once you have found the origin.

### The 5 Whys

For every bug, keep asking "why?" until you reach a systemic cause, not just a one-off mistake:

| Depth | Example |
|-------|---------|
| Symptom | The API returned 500 |
| Why? | `NullPointerException` on `user.name` |
| Why? | `user` was null because `findUser` returned null |
| Why? | `findUser` queries by email, but the request had no email |
| Why? | The caller did not pass the email field |
| **Why?** | **The API contract did not declare email as required** |

The root cause is at depth 5: the contract allowed an invalid state. Patching depth 2 (null check) is a bandaid. Fixing depth 5 (require the field at the API boundary) prevents the entire class of bug.

### Bug-category strategies

Different bugs need different root-cause hunting:

- **Race conditions / ordering bugs:** Identify the shared state and the ordering assumption that broke. Add deterministic logging at the contention points before and after. The root cause is the missing synchronisation or the incorrect assumption about execution order — not the symptom of "sometimes X is null."
- **Off-by-one / boundary errors:** Reproduce with the boundary values (empty, zero, max, min, one past the end). The root cause is which edge the logic gets wrong, not the line that crashes.
- **Contract violations:** Identify which side broke the contract — did the caller violate a precondition, or did the callee violate a postcondition? The root cause is either the broken enforcement on one side or the incorrect documentation on the other.
- **Configuration / environment drift:** Diff the working and broken environments (env vars, config files, feature flags, dependency versions, OS/user). Do not focus on code until you have ruled out config.
- **State corruption:** Trace when the state diverges from expected, not when the corruption is first observed. Add a watchpoint/assertion on the state mutation and find who wrote the bad value.
- **Logic / assumption errors:** State the assumption you believe the code makes, then prove it holds at every call site. The root cause is the assumption that is false, not the code that acts on it.

### Hypothesis-driven search

When the cause is not obvious from reading, form hypotheses and test them one at a time:

1. State it explicitly: "I think X is the root cause because Y."
2. Define the prediction: "If X is the cause, then changing Z makes the bug disappear."
3. Test with the **smallest possible change**, one variable at a time.
4. Predict the outcome before you run. If you were wrong, form a *new* hypothesis — do not pile a second change on top of the first.
5. If you do not understand something, say so and go find out; do not pretend.

If you cannot state a falsifiable prediction, it is a vibe — sharpen or discard it.

When the same hypothesis keeps failing, you are anchored on the wrong layer. Go up one level of abstraction and re-examine what you assumed was true.

## Phase 3 — Confirm the root cause

Before handing off to a fix, verify that you have actually found the root cause, not just a plausible proximate cause:

1. **Explain all three levels:** You can clearly state what happened, why it happened, and why it was not prevented.
2. **The fix prevents the class, not the instance:** If someone makes the same kind of mistake at a different call site tomorrow, would your fix catch it? If no, you are fixing a symptom.
3. **The reverse test:** If you undo the cause (not just patch over it), does the bug disappear for every path that could hit it?
4. **No unexplained observations:** Every log line, every stack frame, every value you saw makes sense under your root-cause explanation. If anything remains "weird but probably unrelated," you do not have the full picture.
5. **The working path confirms it:** The similar code or scenario that works makes sense under your explanation — the difference is precisely the cause.
6. **The timeline fits:** The root cause was present before the symptom appeared. If you are blaming a recent change, that change must predate the first observed failure.

If any of these fail, return to Phase 2. You are not at the root cause yet.

If the root cause is architectural — no good seam, tangled callers, hidden coupling, unfixable without a redesign — do not force a patch. Write up your findings and hand off to [[improve]] after the fix is in.

## Phase 4 — Hand off to the fix

Once the cause is confirmed, the fix itself is governed by [[fix]]: a minimal fix at the source, a test that reproduces the bug, and proof the symptom is actually gone. One change — no "while I am here" refactoring bundled in.

## Stop if you catch yourself thinking…

- "Quick fix for now, I will investigate later" — no, investigate now.
- "Let me just try changing this and see" — that is guessing, not debugging.
- "I see the problem" — you see *a* symptom; prove it is the cause.
- "One more fix attempt" after 2+ failures — stop (see below).
- "That is weird, but probably unrelated" — it is almost certainly related. Investigate it.
- "The root cause is obvious" — the most expensive bugs in history were all "obvious" root causes that were not.

## Three strikes → it is the architecture, not the bug

If three fixes have failed, or each fix spawns a new problem somewhere else, stop fixing. That pattern means the design is wrong, not that you need a fourth patch. Write up what you found — the recurring pattern, the missing seam, the tangled coupling — and raise it with your human partner before continuing. This is an architecture conversation, not another guess. Consider [[improve]].

---

*Adapted from [obra/superpowers](https://github.com/obra/superpowers) `systematic-debugging` and `root-cause-tracing` (MIT, © 2025 Jesse Vincent), rewritten and condensed. 5 Whys technique from Taiichi Ohno (Toyota Production System). Pairs with [[fix]], [[diagnose]], [[improve]], and [[research]].*
