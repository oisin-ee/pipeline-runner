---
name: research
description: Use whenever researching a technical question — a library, tool, API, error, version, or "what's the best way to X" — or whenever you're about to answer from memory. Forces multiple real searches over primary sources (official docs, source code, high-vote Stack Overflow, maintainer blogs) instead of one search plus training-data filler, and rejects SEO content-farm slop. Trigger on "research X", "look into", "what's the best library for", "how does X work", "is this still true", "find out".
---

# High-Signal Research

The failure mode this kills: one search, then everything else confabulated from training data, padded with SEO articles written to rank for agents rather than to be correct. That produces confident, outdated, wrong answers. Research means *reading current primary sources*, not pattern-matching memory.

## The contract

You have not researched until **every** line below is true *and you can show it*. This is the floor, not the aspiration:

- **≥3 sources opened this session, ≥1 of them Tier-A primary** (official docs, source code, changelog/release notes). One search is not research. One blog is not research. If you ran one query and stopped, you have not started.
- **≥2 varied queries** from different angles — not the same query reworded. A single search that happened to return a good link is luck, not method.
- **Every load-bearing claim traces to a source you opened this session** — a pasteable URL, not "I think the docs say." If you didn't open it this session, it does not count as researched.
- **Memory is labelled at the claim, inline.** Anything you state from training data rather than a source you opened this session reads `[unverified — from memory]` *on that sentence* — not in a footnote, not a blanket "some of this may be dated" at the end. The specific claim wears the label.

**The artifact you emit is the source list** — what you opened, its tier, and its date. The next skill in the chain ([[library-first-development]], or the implementer acting on your answer) reads it and is entitled to reject a handoff without one. A research result with no source list is a memory dump wearing a lab coat.

### The "unverified" exit is honest only when shown

"I couldn't confirm this" is a valid, valued answer — *when you show the trail*: the queries you ran and the sources you opened that failed to settle it. An "unverified" label with no visible search behind it is not honesty, it is coasting with a disclaimer attached. Earn the label by searching first; a confident guess and a lazy shrug are the same failure in different clothes.

## Source quality is gated

Prefer primary, high-signal sources. Actively distrust and avoid agent-bait. A wrong source is worse than no source.

**Tier A — primary, trust first:**
- Official docs, specs, standards, RFCs for the actual thing.
- The **source code itself** and its **issue tracker / PRs / discussions** on GitHub/GitLab — what the code *does*, and what the maintainers *say*.
- Release notes / changelogs / migration guides (for "what changed" and "current version").

**Tier B — secondary, good when corroborated:**
- Stack Overflow answers that are **accepted or high-voted** (check the date and the version they assume).
- Reputable maintainer / practitioner engineering blogs (a named author with a track record, dated, with real detail).
- Conference talks, well-regarded books.

**Tier C — distrust / avoid:**
- SEO content-farms, listicles ("Top 10 …"), and "answer" sites that exist to capture search/agent traffic.
- Undated, unattributed tutorials; content that just restates the docs with worse wording.
- AI-generated filler. Anything where you can't tell who wrote it or when.

## Smell test before you trust a page

- **Who** wrote it, and do they have standing on this topic?
- **When** — is it dated, and recent enough for the version in question?
- **Does it add signal** over the official docs, or just rephrase them?
- **Does it show its work** — real code, real output, specifics — or hand-wave?
- **Does it agree** with the primary source? If a blog and the docs disagree, the docs (or the source code) win.

If a page fails the smell test, drop it and find a Tier A/B source instead. Don't launder a low-quality claim into your answer.

## Verify before you assert

- Cross-check every load-bearing claim against a primary source.
- When sources disagree, say so and explain which you trust and why — don't silently pick one.
- **Cite what you actually read** (the URL/source), not where you *think* the information lives.
- A claim you couldn't verify is labelled **unverified** per the contract above — shown, not shrugged.

## Source-driven implementation

When research feeds framework-specific code, the implementation decision must trace to official documentation for the detected version. Read dependency files first (`package.json`, `pyproject.toml`, `go.mod`, etc.), fetch the relevant official docs or source, implement the documented pattern, and cite the source in the handoff. Do not use blog posts, examples from memory, or training data as primary authority for current APIs.

## When this feeds a build decision

Choosing a library/tool from this research? Hand the candidates *and the source list* to [[library-first-development]] for the vetting step — adoption, maintenance, bus factor, license, security.

---

*Original skill for Oisín's skills repo, with source-driven implementation guidance folded in from local oisin-pipeline material. Pairs with [[library-first-development]]; the same "verify, don't assume" discipline as [[fix]].*
