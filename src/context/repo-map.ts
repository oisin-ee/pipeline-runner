import { createRequire } from "node:module";
import { extname, join, relative } from "node:path";
import { Effect } from "effect";
import Graph from "graphology";
// graphology-metrics ships no package "exports" map, so node/nub strict ESM
// cannot resolve the extensionless subpath (only bun + the tsdown bundle do).
// Import the real file with its .js extension so the unbundled CLI
// (`nub src/index.ts`) boots, not just the bundled dist bin.
import pagerank from "graphology-metrics/centrality/pagerank.js";
import {
  type Language,
  type Parser,
  Query,
  type QueryMatch,
} from "web-tree-sitter";
import {
  RepoIoService,
  RepoIoServiceLive,
} from "../runtime/services/repo-io-service";
import { estimateTokens as defaultEstimateTokens } from "../token-estimator";

/**
 * PIPE-83.2: repo-map context selector. Parses the worktree with web-tree-sitter
 * (combined JS+TS tags query — the TS grammar's tags.scm only covers signatures,
 * so it is concatenated with the JS grammar's), builds a file/symbol reference
 * graph, ranks symbols with graphology PageRank biased by a deterministic seed
 * bonus (task text + NodeHandoff artifacts), and binary-searches the included
 * symbol count to fit a token budget. Deterministic for fixed inputs.
 */
interface RepoMapArtifact {
  lineRange?: [number, number];
  path: string;
}

interface RepoMapInput {
  artifacts: RepoMapArtifact[];
  estimateTokens?: (text: string) => number;
  taskText: string;
  tokenBudget: number;
  worktreePath: string;
}

interface RepoMapSelectedSymbol {
  kind: string;
  lineRange: [number, number];
  matchedSeed: boolean;
  name: string;
  path: string;
  score: number;
}

interface RepoMapResult {
  budget: number;
  context: string;
  estimatedTokens: number;
  selected: RepoMapSelectedSymbol[];
  totalRanked: number;
}

interface Definition {
  endLine: number;
  kind: string;
  name: string;
  path: string;
  startLine: number;
}

interface FileTags {
  definitions: Definition[];
  path: string;
  references: string[];
}

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".pipeline"]);
// PageRank scores sum to 1 (each well below 1), so a +1 bonus deterministically
// ranks every seeded symbol above non-seeded ones, PageRank breaking ties within
// each group. This is library PageRank biased by seeds, not hand-rolled.
const SEED_BONUS = 1;
const WORD_RE = /[a-z_][a-z0-9_]+/gi;
const require = createRequire(import.meta.url);

const queryCache = new Map<string, Query>();

function tagsQueryEffect(
  language: Language,
  grammar: string
): Effect.Effect<Query, unknown, RepoIoService> {
  const cached = queryCache.get(grammar);
  if (cached) {
    return Effect.succeed(cached);
  }
  return Effect.gen(function* () {
    const service = yield* RepoIoService;
    const js = yield* service.readText(
      require.resolve("tree-sitter-javascript/queries/tags.scm")
    );
    const ts = yield* service.readText(
      require.resolve("tree-sitter-typescript/queries/tags.scm")
    );
    const query = yield* Effect.try({
      catch: (error) => error,
      try: () => new Query(language, `${js}\n${ts}`),
    });
    queryCache.set(grammar, query);
    return query;
  });
}

function grammarFor(file: string): "javascript" | "typescript" {
  const ext = extname(file);
  return ext === ".ts" || ext === ".tsx" ? "typescript" : "javascript";
}

function discoverFilesEffect(
  root: string
): Effect.Effect<string[], unknown, RepoIoService> {
  return Effect.gen(function* () {
    const found: string[] = [];
    yield* walkDirEffect(root, found);
    return found.sort();
  });
}

function walkDirEffect(
  dir: string,
  found: string[]
): Effect.Effect<void, unknown, RepoIoService> {
  return Effect.gen(function* () {
    const service = yield* RepoIoService;
    for (const entry of yield* service.readDir(dir)) {
      yield* handleEntryEffect(join(dir, entry.name), entry.name, found);
    }
  });
}

function handleEntryEffect(
  full: string,
  name: string,
  found: string[]
): Effect.Effect<void, unknown, RepoIoService> {
  if (SKIP_DIRS.has(name)) {
    return Effect.void;
  }
  return Effect.gen(function* () {
    const service = yield* RepoIoService;
    if (yield* service.isDirectory(full)) {
      return yield* walkDirEffect(full, found);
    }
    addSourceFile(full, name, found);
  });
}

function addSourceFile(full: string, name: string, found: string[]): void {
  if (SOURCE_EXTENSIONS.has(extname(name))) {
    found.push(full);
  }
}

function tagFileEffect(
  root: string,
  file: string
): Effect.Effect<FileTags, unknown, RepoIoService> {
  return Effect.gen(function* () {
    const service = yield* RepoIoService;
    const parser = yield* service.createParser();
    const content = yield* service.readText(file);
    return yield* parseFileTags(root, file, parser, content);
  });
}

function parseFileTags(
  root: string,
  file: string,
  parser: Parser,
  content: string
): Effect.Effect<FileTags, unknown, RepoIoService> {
  const grammar = grammarFor(file);
  const path = relative(root, file);
  return Effect.gen(function* () {
    const service = yield* RepoIoService;
    const language = yield* service.loadLanguage(
      require.resolve(`tree-sitter-${grammar}/tree-sitter-${grammar}.wasm`)
    );
    parser.setLanguage(language);
    const tree = parser.parse(content);
    const tags: FileTags = { definitions: [], path, references: [] };
    const query = yield* tagsQueryEffect(language, grammar);
    if (tree) {
      for (const match of query.matches(tree.rootNode)) {
        addMatch(tags, path, match);
      }
    }
    return tags;
  });
}

function addMatch(tags: FileTags, path: string, match: QueryMatch): void {
  const nameCapture = match.captures.find((c) => c.name === "name");
  if (!nameCapture) {
    return;
  }
  const name = nameCapture.node.text;
  const def = match.captures.find((c) => c.name.startsWith("definition."));
  if (def) {
    tags.definitions.push({
      endLine: def.node.endPosition.row + 1,
      kind: def.name.slice("definition.".length),
      name,
      path,
      startLine: def.node.startPosition.row + 1,
    });
    return;
  }
  if (match.captures.some((c) => c.name.startsWith("reference."))) {
    tags.references.push(name);
  }
}

function definitionKey(def: Definition): string {
  return `def:${def.path}#${def.name}#${def.startLine}`;
}

function isSeeded(
  def: Definition,
  seedNames: Set<string>,
  artifacts: RepoMapArtifact[]
): boolean {
  if (seedNames.has(def.name.toLowerCase())) {
    return true;
  }
  return artifacts.some(
    (artifact) =>
      artifact.path === def.path &&
      (!artifact.lineRange ||
        (def.startLine <= artifact.lineRange[1] &&
          def.endLine >= artifact.lineRange[0]))
  );
}

function buildGraph(fileTags: FileTags[], input: RepoMapInput): Graph {
  const seedNames = new Set(input.taskText.toLowerCase().match(WORD_RE) ?? []);
  const graph = new Graph({ allowSelfLoops: false, type: "directed" });
  const defsByName = new Map<string, string[]>();
  for (const file of fileTags) {
    for (const def of file.definitions) {
      addDefNode(
        graph,
        defsByName,
        def,
        isSeeded(def, seedNames, input.artifacts)
      );
    }
  }
  linkReferences(graph, fileTags, defsByName);
  return graph;
}

function addDefNode(
  graph: Graph,
  defsByName: Map<string, string[]>,
  def: Definition,
  matchedSeed: boolean
): void {
  const key = definitionKey(def);
  graph.mergeNode(key, { def, matchedSeed });
  defsByName.set(def.name, [...(defsByName.get(def.name) ?? []), key]);
}

function linkReferences(
  graph: Graph,
  fileTags: FileTags[],
  defsByName: Map<string, string[]>
): void {
  for (const file of fileTags) {
    const fileKey = `file:${file.path}`;
    graph.mergeNode(fileKey);
    linkFileReferences(graph, fileKey, file.references, defsByName);
  }
}

function linkFileReferences(
  graph: Graph,
  fileKey: string,
  references: string[],
  defsByName: Map<string, string[]>
): void {
  for (const name of references) {
    for (const target of defsByName.get(name) ?? []) {
      graph.mergeEdge(fileKey, target, { weight: 1 });
    }
  }
}

// PIPE-83.2: pagerank can fail to converge on some graph shapes, and the repo
// map is a best-effort context aid that must never break a run. On failure fall
// back to uniform ranks so ordering is driven by the seed bonus + deterministic
// tie-break.
function pagerankScores(graph: Graph): Record<string, number> {
  try {
    return pagerank(graph, {
      getEdgeWeight: "weight",
      maxIterations: 200,
      tolerance: 1e-4,
    });
  } catch {
    return {};
  }
}

function rankDefinitions(graph: Graph): RepoMapSelectedSymbol[] {
  const scores = pagerankScores(graph);
  const ranked: RepoMapSelectedSymbol[] = [];
  graph.forEachNode((key, attrs) => {
    if (key.startsWith("def:")) {
      ranked.push(
        toSymbol(
          attrs.def as Definition,
          Boolean(attrs.matchedSeed),
          scores[key] ?? 0
        )
      );
    }
  });
  return ranked.sort(compareSymbols);
}

function toSymbol(
  def: Definition,
  matchedSeed: boolean,
  pageRankScore: number
): RepoMapSelectedSymbol {
  return {
    kind: def.kind,
    lineRange: [def.startLine, def.endLine],
    matchedSeed,
    name: def.name,
    path: def.path,
    score: pageRankScore + (matchedSeed ? SEED_BONUS : 0),
  };
}

function compareSymbols(
  a: RepoMapSelectedSymbol,
  b: RepoMapSelectedSymbol
): number {
  return (
    b.score - a.score ||
    a.path.localeCompare(b.path) ||
    a.name.localeCompare(b.name) ||
    a.lineRange[0] - b.lineRange[0]
  );
}

function renderContext(selected: RepoMapSelectedSymbol[]): string {
  return [
    "Repo map context:",
    ...selected.map(
      (s) =>
        `## ${s.path}:${s.lineRange[0]}-${s.lineRange[1]}\n${s.kind} ${s.name}`
    ),
  ].join("\n");
}

function selectWithinBudget(
  ranked: RepoMapSelectedSymbol[],
  budget: number,
  estimateTokens: (text: string) => number
): {
  context: string;
  estimatedTokens: number;
  selected: RepoMapSelectedSymbol[];
} {
  let low = 0;
  let high = ranked.length;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (estimateTokens(renderContext(ranked.slice(0, mid))) <= budget) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const selected = ranked.slice(0, best);
  const context = renderContext(selected);
  return { context, estimatedTokens: estimateTokens(context), selected };
}

export function buildRepoMapContext(
  input: RepoMapInput
): Promise<RepoMapResult> {
  return Effect.runPromise(
    Effect.provide(buildRepoMapContextEffect(input), RepoIoServiceLive)
  );
}

function buildRepoMapContextEffect(
  input: RepoMapInput
): Effect.Effect<RepoMapResult, unknown, RepoIoService> {
  return Effect.gen(function* () {
    const estimateTokens = input.estimateTokens ?? defaultEstimateTokens;
    const files = yield* discoverFilesEffect(input.worktreePath);
    const fileTags = yield* Effect.all(
      files.map((file) => tagFileEffect(input.worktreePath, file)),
      { concurrency: "unbounded" }
    );
    const ranked = rankDefinitions(buildGraph(fileTags, input));
    const { context, estimatedTokens, selected } = selectWithinBudget(
      ranked,
      input.tokenBudget,
      estimateTokens
    );
    return {
      budget: input.tokenBudget,
      context,
      estimatedTokens,
      selected,
      totalRanked: ranked.length,
    };
  });
}
