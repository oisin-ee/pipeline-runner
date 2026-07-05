---
id: PIPE-83.2
title: >-
  Add repo-map context selector (tree-sitter + personalized PageRank + token
  budget)
status: Done
assignee: []
created_date: "2026-06-15 17:33"
updated_date: "2026-06-16 08:51"
labels:
  - architecture
  - context-engineering
dependencies: []
references:
  - src/token-estimator.ts
parent_task_id: PIPE-83
priority: high
ordinal: 220000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Workstream A. Select the RIGHT code context for a node instead of dumping upstream text (Aider's repo-map algorithm).

SEAM: new src/context/repo-map.ts. Build a symbol/reference graph from web-tree-sitter tags, rank with personalized PageRank (graphology / graphology-metrics) seeded by the node's task text + its needs' handoff artifacts (from PIPE-83.1), then binary-search the included tag count to fit a token budget (reuse src/token-estimator.ts). Output: a compact ranked code-context string + the selected file/symbol list.

LIBRARY-FIRST: do NOT hand-roll PageRank or a tokenizer. Pure and deterministic for fixed inputs.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 repo-map produces a ranked context string that fits a given token budget via binary search over tag count
- [x] #2 Seeding by task text + needs-artifacts measurably reorders results versus unseeded ranking (asserted in a test)
- [x] #3 Uses web-tree-sitter + graphology; no hand-rolled PageRank or tokenizer
- [x] #4 Deterministic for fixed inputs; unit tests assert budget adherence and the seeding effect
- [x] #5 npx tsc --noEmit is clean
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

RECON (MoKa Researcher, verified via npm view + npm pack --dry-run). LIBRARIES (all MIT, none currently deps; add to dependencies): web-tree-sitter@0.26.9, tree-sitter-typescript@0.23.2 (ships .wasm + queries/tags.scm), tree-sitter-javascript@0.25.0, graphology@0.26.0, graphology-metrics@2.4.0 (pagerank at import path 'graphology-metrics/centrality/pagerank'). DO NOT use @tree-sitter-grammars/\* (404 on npm). CAVEAT: graphology-metrics PageRank has NO non-uniform personalization/teleport vector — implement personalization by adding deterministic weighted seed/query nodes+edges BEFORE running PageRank (= seeded PageRank; document honestly; still satisfies library-first / no-hand-rolled-PageRank). INTERFACE: src/context/repo-map.ts exports `buildRepoMapContext(input: RepoMapInput): Promise<RepoMapResult>` — input {worktreePath, taskText, artifacts:{path,lineRange?}[], tokenBudget, estimateTokens?}, output {context, selected, estimatedTokens, totalRanked, budget}. Reuse estimateTokens from src/token-estimator.ts. ASYNC CAVEAT: web-tree-sitter load is async, so renderAgentPrompt (currently SYNC) must become async (await buildRepoMapContext from executeAgentNode) — that change lands in PIPE-83.5, not here. Binary-search selected tag count until estimateTokens(context) <= budget. Determinism: sort all file-discovery/tags/graph-insertion; no timestamps/random.

SMOKE-TEST FINDING (2026-06-15, controller, before parking): the recon-pinned versions install and web-tree-sitter@0.26.9 parses TS correctly (ABI 14, clean function_declaration tree, Parser.init + Language.load + new Query all work). BUT tree-sitter-typescript@0.23.2's queries/tags.scm captures ONLY TS-specific SIGNATURES (function_signature, method_signature, abstract_class_declaration, interface, module) — it has NO function_declaration/class_declaration/method_definition patterns, because those live in the tree-sitter-JAVASCRIPT grammar it extends. So a plain TS tags query returns ZERO captures on real implementation code. IMPLEMENTATION REQUIREMENT for whoever takes this: run a COMBINED JS + TS tags query (concatenate tree-sitter-javascript/queries/tags.scm + tree-sitter-typescript/queries/tags.scm, or author a known-good combined query a la Aider's), and select the grammar per extension (.ts/.tsx -> typescript/tsx wasm, .js/.jsx/.mjs/.cjs -> javascript wasm). web-tree-sitter Query API confirmed: new Query(language, sourceString); query.captures(tree.rootNode) -> {name, node}[]. This is genuine tree-sitter-tags work, not a quick lane — schedule accordingly. Deps parked (removed) until then.

<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->

RE-PARKED (2026-06-16): the module APPROACH IS PROVEN and was fully built + tested (3 tests green: budget binary-search adherence, seeding reorder, determinism) before reverting. Working recipe to reinstate: (1) deps web-tree-sitter@0.26.9 + tree-sitter-typescript@0.23.2 + tree-sitter-javascript@0.25.0 + graphology@0.26.0 + graphology-metrics@2.4.0. (2) COMBINED tags query = concat tree-sitter-javascript/queries/tags.scm + tree-sitter-typescript/queries/tags.scm (resolved via createRequire(import.meta.url).resolve), parsed per-extension grammar. (3) web-tree-sitter 0.26 API: await Parser.init(); Language.load(wasmPath); new Query(lang, src); query.matches(tree.rootNode) -> matches[].captures[{name,node}] (pair @name with @definition.X / @reference.X; guard the nullable parser.parse result). (4) graphology directed graph of def + file nodes; file->def reference edges; rank with `pagerank(graph, { getEdgeWeight: 'weight' })`; SEED VIA A DETERMINISTIC +1 BONUS on seeded defs (NOT edge weight — a lone seed out-edge gets normalized away by PageRank), where seeded = name in lowercased task-text tokens OR artifact path/lineRange overlap. (5) binary-search included symbol count until estimateTokens(renderContext(slice)) <= budget. buildRepoMapContext(input): Promise<RepoMapResult>. TWO LANDING BLOCKERS to resolve when finishing: (A) DEAD-FILE — the module needs a src consumer, i.e. ship it together with the PIPE-83.5 repo-map wiring (make renderAgentPrompt async + await buildRepoMapContext, gated default-off, extracted so renderAgentPrompt's complexity doesn't worsen). (B) UNUSED-DEP — the grammar packages are loaded by require.resolve (runtime), invisible to fallow's static analysis, so add a fallow config (.fallowrc.json / fallow.toml, supported per `fallow audit --config`) allowlisting tree-sitter-javascript + tree-sitter-typescript. Land 83.2 + the 83.5 repo-map half together to clear both.

<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Committed fe08451 (pushed to main). src/context/repo-map.ts: web-tree-sitter parse with a COMBINED JS+TS tags query (the TS grammar's tags.scm only covers signatures; concatenated with the JS grammar's for function/class/method captures), file/symbol reference graph in graphology, ranked with library PageRank biased by a deterministic +1 SEED BONUS (seeded = name in lowercased task-text tokens OR artifact path/lineRange overlap — edge-weight seeding gets normalized away, so a bonus is used), binary-searching included symbols to fit a token budget. Wired into renderAgentPrompt (now async; complexity unchanged via an extracted repoMapSection) behind a default-OFF repo_map config flag { enabled, token_budget }; artifacts come from the dependencies' NodeHandoffs (PIPE-83.1). Added .fallowrc.json ignoreDependencies for the tree-sitter grammar packages (runtime require.resolve'd .wasm, invisible to static dep analysis). All functions kept <=4 cyclomatic to pass the audit. Tests (temp TS fixture): budget binary-search adherence, task-seeding reorder, determinism. Verified: tsc clean, ultracite clean, fallow-audit clean, full suite 613 passed / 4 skipped. This also completes the repo-map half of PIPE-83.5.

<!-- SECTION:FINAL_SUMMARY:END -->
