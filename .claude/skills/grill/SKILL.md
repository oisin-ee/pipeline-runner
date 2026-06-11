---
name: grill
description: Use to stress-test a plan, spec, or design BEFORE committing to it — a relentless one-question-at-a-time interview that checks it against the actual codebase and the project's own glossary. Surfaces vague terms, fuzzy boundaries, unstated assumptions, and contradictions with existing code while they're cheap to fix. Trigger on "grill this plan", "poke holes in this", "is this design sound", "stress-test the spec", and as the review step inside the scope skill.
---

# Grill the Plan

A plan sounds finished long before it *is* finished. This skill is the interview that finds the gap between "sounds right" and "is right" — by interrogating the plan against the two things it can't argue with: the actual code, and the project's own established language. Run it before tickets exist, when changing your mind costs a sentence instead of a worktree.

## How to grill

**One question at a time.** Ask, wait for the answer, let it reshape the next question. A wall of twenty questions gets a wall of twenty shallow answers; a sequence gets you to the real constraint.

**Check the code before you ask.** If the answer is already in the repo, go read it — don't make the user recite what the code already states. Reserve questions for what only a human knows: intent, priorities, trade-offs, the future.

**Ask the question with its recommendation.** Don't just surface a problem — propose the resolution you'd pick, so the user can agree, correct, or veto in one turn.

## What to hunt for

- **Terminology conflicts.** When the plan's words contradict the project's glossary (`CONTEXT.md` or equivalent), surface it on the spot: *"Your glossary defines 'cancellation' as a refund event, but here you're using it for an abandoned cart — which is it?"* Mismatched vocabulary is a mismatched model, and it ships as bugs.
- **Vague, overloaded terms.** Sharpen them with a proposal: *"You said 'account' — do you mean the billing Customer or the auth User? I'll assume Customer unless you say otherwise."*
- **Fuzzy boundaries.** Stress-test the edges with concrete, invented scenarios that force precision about where one concept ends and the next begins: *"A user deletes their org while a job is mid-run — does the job still see the org or not?"*
- **Code-reality contradictions.** When the plan assumes behaviour the code doesn't have, flag it with the evidence: *"The plan says auth middleware already injects the tenant, but `auth.ts:40` only sets the user — the tenant is never read. Who adds it?"*

## Capture as you go

Resolve terms into the glossary **inline**, the moment they settle — not batched at the end, where half of them are forgotten. Keep `CONTEXT.md` a pure glossary: definitions only, no specs, no scratch notes, no implementation detail.

Record a decision as an **ADR only when all three hold**: it's hard to reverse, it's surprising without the context, and it came from a genuine trade-off. Most decisions clear none of these — don't manufacture ceremony. The ones that clear all three are exactly the ones the next person will otherwise re-litigate.

## When it's done

The plan is grilled when you can't find a term that two people would read differently, a boundary that a scenario can break, or an assumption the code contradicts. Hand the hardened plan back to [[scope]] for decomposition — every ambiguity you killed here is a ticket that won't stall mid-implementation.

## The short version

Interview the plan one question at a time, against the code and the glossary. Read the repo before asking. Surface terminology clashes, sharpen vague terms, break fuzzy boundaries with scenarios, flag claims the code contradicts. Update the glossary inline; write an ADR only when it's hard-to-reverse, surprising, *and* a real trade-off.

---

*Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) `grill-with-docs` (MIT, © 2026 Matt Pocock). The interrogation step inside [[scope]]; pairs with [[improve]] (grilling a chosen design) and [[research]] (when an answer needs a primary source, not a guess).*
