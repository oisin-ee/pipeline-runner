---
name: research
description: Use whenever researching a technical question — a library, tool, API, error, version, or "what's the best way to X" — or whenever you're about to answer from memory. Forces multiple real searches over primary sources (official docs, source code, high-vote Stack Overflow, maintainer blogs) instead of one search plus training-data filler, and rejects SEO content-farm slop. Trigger on "research X", "look into", "what's the best library for", "how does X work", "is this still true", "find out".
---

# High-Signal Research

The failure mode this kills: one search, then everything else confabulated from training data, padded with SEO articles written to rank for agents rather than to be correct. That produces confident, outdated, wrong answers. Research means *reading current primary sources*, not pattern-matching memory.

## Two hard rules

1. **No coasting.** One search is never the research. Run several varied queries, open multiple sources, and read them. Any claim about current or version-specific behaviour must trace to a source you actually opened *this session* — not to training data. If you're stating something from memory, say so, then go verify it.
2. **Source quality is gated.** Prefer primary, high-signal sources. Actively distrust and avoid agent-bait. A wrong source is worse than no source.

## Source tiers

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
- If you couldn't verify something, label it **unverified** rather than stating it as fact. "I couldn't confirm this" is a valid, valued answer; a confident guess is not.

## Source-driven implementation

When research feeds framework-specific code, the implementation decision must trace to official documentation for the detected version. Read dependency files first (`package.json`, `pyproject.toml`, `go.mod`, etc.), fetch the relevant official docs or source, implement the documented pattern, and cite the source in the handoff. Do not use blog posts, examples from memory, or training data as primary authority for current APIs.

## When this feeds a build decision

Choosing a library/tool from this research? Hand the candidates to [[library-first-development]] for the vetting step — adoption, maintenance, bus factor, license, security.

---

*Original skill for Oisín's skills repo, with source-driven implementation guidance folded in from local oisin-pipeline material. Pairs with [[library-first-development]]; the same "verify, don't assume" discipline as [[fix]].*
