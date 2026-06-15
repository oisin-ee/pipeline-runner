import { describe, expect, it } from "vitest";
import {
  handoffFinalizerPrompt,
  parseHandoff,
  renderHandoff,
  synthesizeMinimalHandoff,
} from "./handoff";

describe("parseHandoff", () => {
  it("defaults arrays when only a summary is provided", () => {
    expect(parseHandoff('{"summary":"x"}')).toEqual({
      artifacts: [],
      decisions: [],
      openQuestions: [],
      summary: "x",
      testNames: [],
    });
  });

  it("parses a Markdown-fenced JSON handoff", () => {
    const raw = '```json\n{"summary":"done","decisions":["a"]}\n```';
    expect(parseHandoff(raw)?.summary).toBe("done");
    expect(parseHandoff(raw)?.decisions).toEqual(["a"]);
  });

  it("returns null on non-JSON or when the required summary is missing", () => {
    expect(parseHandoff("not json at all")).toBeNull();
    expect(parseHandoff('{"decisions":[]}')).toBeNull();
  });
});

describe("synthesizeMinimalHandoff", () => {
  it("uses trimmed output text as the summary with empty arrays", () => {
    const handoff = synthesizeMinimalHandoff("  hello world  ");
    expect(handoff.summary).toBe("hello world");
    expect(handoff.decisions).toEqual([]);
    expect(handoff.artifacts).toEqual([]);
  });

  it("truncates a long output", () => {
    expect(synthesizeMinimalHandoff("a".repeat(1000)).summary.length).toBe(600);
  });
});

describe("renderHandoff", () => {
  it("renders the node id, summary, and only non-empty sections", () => {
    const text = renderHandoff("green", {
      artifacts: [{ lineRange: [1, 9], path: "src/a.ts" }],
      decisions: ["use zod"],
      openQuestions: [],
      summary: "impl done",
      testNames: ["a.test.ts"],
    });
    expect(text).toContain("## green");
    expect(text).toContain("impl done");
    expect(text).toContain("- use zod");
    expect(text).toContain("- src/a.ts:1-9");
    expect(text).toContain("- a.test.ts");
    expect(text).not.toContain("Open questions");
  });
});

describe("handoffFinalizerPrompt", () => {
  it("includes the raw output and the JSON-only instruction", () => {
    const prompt = handoffFinalizerPrompt("RAW_NODE_OUTPUT");
    expect(prompt).toContain("RAW_NODE_OUTPUT");
    expect(prompt).toContain("ONLY a JSON object");
  });
});
