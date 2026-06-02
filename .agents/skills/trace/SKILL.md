---
name: trace
description: Use when investigating ANY bug, test failure, crash, hang, flaky test, or unexpected/"weird" behaviour — BEFORE proposing or writing a fix. Forces finding the real root cause instead of guessing, patching the first thing you see, or fixing the symptom. Trigger on "why is this broken", "this is acting weird", "debug this", "the test fails", "it works sometimes".
---

# Systematic Debugging

Guessing wastes time and ships new bugs. The first explanation that comes to mind is usually the symptom, not the cause. This skill is the investigation discipline you run before you are allowed to touch a fix.

## The one rule

**No fix until you have found the root cause. Finding the cause is a separate step from fixing it, and it comes first.**

If you have not finished Phase 1, you do not get to propose a fix. Not "probably", not "let me just try", not "this should do it". Find the cause, then go to [[fix]] to fix it properly.

Run this even when — *especially* when — the bug looks trivial, you are in a hurry, or someone wants it fixed now. Simple bugs have root causes too, and systematic is faster than thrashing through five guesses.

## Phase 1 — Find the root cause

Before changing a single line:

1. **Read the actual error.** All of it — full message, full stack trace, error codes, line numbers. The answer is often sitting in text you skimmed past.
2. **Reproduce it reliably.** Exact steps. Does it happen every time? If you can't reproduce it, you can't prove you fixed it — gather more data, don't guess.
3. **Check what changed.** `git diff`, recent commits, new deps, config/env differences. Most bugs ride in on a recent change.
4. **Instrument the boundaries** (multi-component systems — request → service → DB, CI → build → sign). Log what data enters and exits each component. Run once to see *which* layer breaks before you go spelunking in the wrong one.
5. **Trace the bad value backward to its origin** (see below). Fix where the bad data is *born*, not where it finally explodes.

### Backward tracing

Bugs surface deep in the stack but originate higher up. Trace, don't patch-at-symptom:

1. Observe the symptom — what failed, exactly?
2. Find the immediate cause — what line directly produces it?
3. Ask "what called this, and with what value?" — go one level up.
4. Keep going up until you find where the bad value/state was actually created.
5. That origin is your root cause. Fix there.

When you can't trace by reading, add instrumentation — dump the value, the `cwd`/env, and `new Error().stack` right before the failing operation, run, and read the output. Use `console.error` (loggers can swallow output in tests). Rip the instrumentation out once you've found it.

## Phase 2 — Compare against what works

Find similar code that *works*. Read it completely — every line, not a skim. List every difference between the working and broken paths, however small ("that can't matter" is how you miss it). Understand the dependencies, config, and assumptions the working path relies on.

## Phase 3 — One hypothesis at a time

State it out loud: "I think X is the root cause because Y." Then test it with the **smallest possible change**, one variable at a time. Predict the outcome before you run. If you were wrong, form a *new* hypothesis — do not pile a second change on top of the first. If you don't understand something, say so and go find out; don't pretend.

## Phase 4 — Hand off to the fix

Once the cause is confirmed, the fix itself is governed by [[fix]]: a minimal fix at the source, a test that reproduces the bug, and proof the symptom is actually gone. One change — no "while I'm here" refactoring bundled in.

## Stop if you catch yourself thinking…

- "Quick fix for now, I'll investigate later" — no, investigate now.
- "Let me just try changing this and see" — that's guessing, not debugging.
- "I see the problem" — you see *a* symptom; prove it's the cause.
- "One more fix attempt" after 2+ failures — stop (see below).

## Three strikes → it's the architecture, not the bug

If three fixes have failed, or each fix spawns a new problem somewhere else, stop fixing. That pattern means the design is wrong, not that you need a fourth patch. Write up what you found and raise it with your human partner before continuing — this is an architecture conversation, not another guess.

---

*Adapted from [obra/superpowers](https://github.com/obra/superpowers) `systematic-debugging` and `root-cause-tracing` (MIT, © 2025 Jesse Vincent), rewritten and condensed. Pairs with [[fix]] and [[research]].*
