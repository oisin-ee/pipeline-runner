---
name: improve
description: Use when code is hard to navigate, change, or test — to find and propose "deepening" refactors that turn shallow modules into deep ones behind clean seams. Use when planning where a new feature's boundaries should live, when diagnose finds no good test seam, or when understanding one concept forces you to bounce across many files. Trigger on "improve the architecture", "this is hard to change", "where should this live", "refactor the structure", "reduce coupling".
---

# Improve Architecture

Good architecture is mostly one thing repeated: **deep modules** — a simple interface hiding a substantial implementation, so a caller gets a lot of behaviour for a little knowledge. The opposite, a **shallow module** whose interface is nearly as complex as what's behind it, earns nothing for the cost of existing; it just moves complexity around and makes you bounce between files to understand one idea. This skill finds the shallow spots and proposes deepening them.

## Vocabulary (use it consistently)

- **Module** — anything with an interface and an implementation: a function, class, file, service.
- **Depth** — how much behaviour the interface buys you. High = deep (good); low = shallow (a thin wrapper, a pass-through).
- **Seam** — where an interface lives; a place you can change behaviour *without editing in place*. Seams are where tests attach and where features extend.
- **Locality** — how concentrated a change is. Deep modules give locality: a change lands in one place, and the knowledge to make it lives there too.
- **Deletion test** — the diagnostic. If you deleted this module, would the complexity it holds *concentrate* somewhere sensible (it was earning its keep — keep it, maybe deepen it) or merely *redistribute* across its callers (it was shallow — the boundary is in the wrong place)?

## Phase 1 — Explore for friction

Walk the code (the project glossary and any ADRs first, so you use the real names and don't re-litigate settled calls). You're not auditing line-by-line — you're feeling for friction:

- Understanding **one** concept makes you open **many** files.
- Interfaces nearly as complex as their implementations (shallow).
- Modules leaking across their seams — callers reaching past the interface into internals.
- Code that's **hard to test**, because there's no seam to attach a test to. (This is often where [[diagnose]] sent you: a bug with no honest regression seam *is* an architecture finding.)

For each friction point, apply the deletion test to decide whether the boundary is missing, misplaced, or merely thin.

## Phase 2 — Report candidates (don't design yet)

Surface the **deepening opportunities** as candidates — for each: the problem (the friction and where it bites), the proposed deeper shape (before → after, in the project's own terms), the benefit (what gets simpler, more testable, more local), and a recommendation strength. **Do not propose detailed interfaces yet** — the report exists so the user can *pick* what's worth pursuing. Designing all of them upfront is wasted work on the ones they'll reject.

Use a strict maintainability lens when looking for candidates: giant files, repeated condition clusters, pass-through wrappers, hidden shared state, confusing compatibility shims, and branches that grow by accretion usually indicate a missing deeper module or misplaced seam.

## Phase 3 — Grill the chosen design

Once the user picks a candidate, design the interface *with* them — and grill it (this is [[grill]] pointed at a design): what are the real constraints? What will the seam need to support a year from now? Update the glossary inline as new terms settle. If a candidate is *rejected* for a reason worth preserving — a trade-off the next person would otherwise re-open — record it as an ADR (and only then: hard to reverse, surprising, genuine trade-off).

## Where this sits

Architecture is planned, not bolted on. In [[scope]], deciding where depth and seams live comes *before* cutting tickets — because tickets that fight the architecture are the ones that collide when fanned out across agents. When [[diagnose]] can't find a regression seam, it hands the specifics here. And the [[test]] refactor step is where small deepenings actually land, one green test at a time.

## The short version

Hunt for shallow modules and missing seams via the deletion test — does removing this *concentrate* complexity or just *spread* it? Report deepening candidates with before/after, don't pre-design them all. Once one's chosen, grill the interface, capture glossary terms inline, ADR only the hard-to-reverse trade-offs. Deep modules, clean seams, local change.

---

*Adapted from [mattpocock/skills](https://github.com/mattpocock/skills) `improve-codebase-architecture` (MIT, © 2026 Matt Pocock); the deep-vs-shallow-module framing traces to John Ousterhout, "A Philosophy of Software Design", with strict maintainability-review guidance folded in from local oisin-pipeline material. Feeds [[scope]], receives hand-offs from [[diagnose]], and pairs with [[grill]], [[test]], and [[critique]].*
