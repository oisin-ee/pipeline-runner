import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

const GRAPH_TOPOSORT_NOTE = [
  /graphlib/i,
  /iterative/i,
  /toposort|topological/i,
  /recursive|stack overflow|deep chain|call stack/i,
];
const GIT_REFS_SOURCE_NOTE = [
  /git refs?|refs\/heads\/pipeline\/runs/i,
  /argo artifacts?/i,
  /semantic state|merged git history|state passing/i,
  /dependency pre-?fetch|dependency/i,
];
const GIT_REFS_DOC_NOTE = [
  /git refs?|refs\/heads\/pipeline\/runs/i,
  /argo artifacts?/i,
  /semantic state|merged git history|state passing/i,
];
const RUNNER_CONTRACT_SOURCE_NOTE = [
  /runner payload|payload v1|contract version/i,
  /pipeline console|external consumers?/i,
  /breaking changes?|stable contract|compatibility/i,
];
const RUNNER_CONTRACT_DOC_NOTE = [
  /runner payload|payload v1|event record schema|schedule artifact|k8s label/i,
  /pipeline console|external consumers?/i,
  /breaking changes?|stable contract|compatibility/i,
];
const ABORT_SIGNAL_RETRY_NOTE = [
  /abortsignal/i,
  /retry delay|delay/i,
  /gate failure|remediation|reprompt|p-?retry/i,
];
const EVENT_SINK_NOTE = [
  /event sink/i,
  /http/i,
  /batching|batch/i,
  /retry/i,
  /k8s events?|kubernetes events?|automation/i,
];
const WHITESPACE_RE = /\s+/g;
const NOTE_BOUNDARY_RE = /\n{2,}/g;
const LEADING_LINE_COMMENT_RE = /^[\t ]*\/\/([^\n]*)/gm;
const BLOCK_COMMENT_RE = /\/\*([\s\S]*?)\*\//g;

describe("PIPE-66 explicit not-changing decision notes", () => {
  it("records the workflow-planner graphlib and iterative toposort tradeoff in source comments", () => {
    const comments = sourceComments("src/workflow-planner.ts");

    expect(comments).toContainDecisionNote(
      "workflow planner toposort",
      GRAPH_TOPOSORT_NOTE
    );
  });

  it("records why runner state uses git refs instead of Argo artifacts", () => {
    const comments = sourceComments("src/run-state/git-refs.ts");

    expect(comments).toContainDecisionNote(
      "runner git refs",
      GIT_REFS_SOURCE_NOTE
    );
  });

  it("records the external consumers that make runner command payloads a stable contract", () => {
    const comments = sourceComments("src/runner-command-contract.ts");

    expect(comments).toContainDecisionNote(
      "runner payload contract",
      RUNNER_CONTRACT_SOURCE_NOTE
    );
  });

  it("summarizes the keep-decisions in README or architecture docs", () => {
    const docs = readArchitectureDocs();

    expect(docs).toContainDecisionNote(
      "graphlib iterative toposort",
      GRAPH_TOPOSORT_NOTE
    );
    expect(docs).toContainDecisionNote(
      "git refs over Argo artifacts",
      GIT_REFS_DOC_NOTE
    );
    expect(docs).toContainDecisionNote(
      "runner external contract",
      RUNNER_CONTRACT_DOC_NOTE
    );
    expect(docs).toContainDecisionNote(
      "AbortSignal retry delay",
      ABORT_SIGNAL_RETRY_NOTE
    );
    expect(docs).toContainDecisionNote(
      "custom event sink batching",
      EVENT_SINK_NOTE
    );
  });
});

expect.extend({
  toContainDecisionNote(
    received: string,
    label: string,
    requiredPatterns: RegExp[]
  ) {
    const notes = received
      .split(NOTE_BOUNDARY_RE)
      .map((candidate) => candidate.replaceAll(WHITESPACE_RE, " ").trim())
      .filter(Boolean);
    const matchingNote = notes.find((note) =>
      requiredPatterns.every((pattern) => pattern.test(note))
    );
    const hasEnoughSubstance =
      (matchingNote?.split(WHITESPACE_RE).filter(Boolean).length ?? 0) >= 12;

    if (matchingNote && hasEnoughSubstance) {
      return {
        message: () => `expected ${label} decision note to be absent`,
        pass: true,
      };
    }

    const combined = notes.join(" ");
    const missing = requiredPatterns.filter(
      (pattern) => !pattern.test(combined)
    );

    return {
      message: () =>
        `expected ${label} decision note to mention ${missing
          .map((pattern) => pattern.toString())
          .join(", ")}${missing.length === 0 ? " in one focused note" : ""}${
          hasEnoughSubstance ? "" : " with substantive prose"
        }`,
      pass: false,
    };
  },
});

function sourceComments(relativePath: string): string {
  const source = readFileSync(join(ROOT, relativePath), "utf8");
  const lineComments = Array.from(
    source.matchAll(LEADING_LINE_COMMENT_RE),
    (match) => match[1]
  );
  const blockComments = Array.from(
    source.matchAll(BLOCK_COMMENT_RE),
    (match) => match[1]
  );
  return [...lineComments, ...blockComments].join("\n\n");
}

function readArchitectureDocs(): string {
  const docsDir = join(ROOT, "docs");
  const markdownDocs = readdirSync(docsDir)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => readFileSync(join(docsDir, entry), "utf8"));
  return [readFileSync(join(ROOT, "README.md"), "utf8"), ...markdownDocs].join(
    "\n\n"
  );
}

interface CustomMatchers<R = unknown> {
  toContainDecisionNote(label: string, requiredPatterns: RegExp[]): R;
}

declare module "vitest" {
  interface Assertion<T = any> extends CustomMatchers<T> {}
  interface AsymmetricMatchersContaining extends CustomMatchers {}
}
