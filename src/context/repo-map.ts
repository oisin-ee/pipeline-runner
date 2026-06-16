import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, relative } from "node:path";
import Graph from "graphology";
import pagerank from "graphology-metrics/centrality/pagerank";
import { Language, Parser, Query, type QueryMatch } from "web-tree-sitter";
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

let parserPromise: Promise<Parser> | null = null;
const languageCache = new Map<string, Promise<Language>>();
const queryCache = new Map<string, Query>();

function getParser(): Promise<Parser> {
  parserPromise ??= Parser.init().then(() => new Parser());
  return parserPromise;
}

function loadLanguage(grammar: "javascript" | "typescript"): Promise<Language> {
  const cached = languageCache.get(grammar);
  if (cached) {
    return cached;
  }
  const promise = Language.load(
    require.resolve(`tree-sitter-${grammar}/tree-sitter-${grammar}.wasm`)
  );
  languageCache.set(grammar, promise);
  return promise;
}

function tagsQuery(language: Language, grammar: string): Query {
  const cached = queryCache.get(grammar);
  if (cached) {
    return cached;
  }
  const js = readFileSync(
    require.resolve("tree-sitter-javascript/queries/tags.scm"),
    "utf8"
  );
  const ts = readFileSync(
    require.resolve("tree-sitter-typescript/queries/tags.scm"),
    "utf8"
  );
  const query = new Query(language, `${js}\n${ts}`);
  queryCache.set(grammar, query);
  return query;
}

function grammarFor(file: string): "javascript" | "typescript" {
  const ext = extname(file);
  return ext === ".ts" || ext === ".tsx" ? "typescript" : "javascript";
}

function discoverFiles(root: string): string[] {
  const found: string[] = [];
  walkDir(root, found);
  return found.sort();
}

function walkDir(dir: string, found: string[]): void {
  for (const entry of readdirSync(dir).sort()) {
    handleEntry(join(dir, entry), entry, found);
  }
}

function handleEntry(full: string, name: string, found: string[]): void {
  if (SKIP_DIRS.has(name)) {
    return;
  }
  if (statSync(full).isDirectory()) {
    walkDir(full, found);
    return;
  }
  if (SOURCE_EXTENSIONS.has(extname(name))) {
    found.push(full);
  }
}

async function tagFile(root: string, file: string): Promise<FileTags> {
  const parser = await getParser();
  const grammar = grammarFor(file);
  const language = await loadLanguage(grammar);
  parser.setLanguage(language);
  const path = relative(root, file);
  const tree = parser.parse(readFileSync(file, "utf8"));
  const tags: FileTags = { definitions: [], path, references: [] };
  if (!tree) {
    return tags;
  }
  for (const match of tagsQuery(language, grammar).matches(tree.rootNode)) {
    addMatch(tags, path, match);
  }
  return tags;
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

function rankDefinitions(graph: Graph): RepoMapSelectedSymbol[] {
  const scores = pagerank(graph, { getEdgeWeight: "weight" });
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

export async function buildRepoMapContext(
  input: RepoMapInput
): Promise<RepoMapResult> {
  const estimateTokens = input.estimateTokens ?? defaultEstimateTokens;
  const fileTags = await Promise.all(
    discoverFiles(input.worktreePath).map((file) =>
      tagFile(input.worktreePath, file)
    )
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
}
