import { describe, expect, it } from "vitest";
import { type Candidate, selectBestCandidate } from "./select-candidate";

function candidate(
  nodeId: string,
  status: "FAIL" | "PASS",
  judgeScore: number | null = null
): Candidate {
  return { judgeScore, nodeId, output: `out-${nodeId}`, status };
}

describe("selectBestCandidate", () => {
  it("returns null when no candidate passes", () => {
    expect(
      selectBestCandidate([candidate("a", "FAIL"), candidate("b", "FAIL")])
    ).toBeNull();
  });

  it("prefers a passing candidate over failing ones", () => {
    expect(
      selectBestCandidate([candidate("a", "FAIL"), candidate("b", "PASS")])
        ?.nodeId
    ).toBe("b");
  });

  it("breaks ties among passing candidates by highest judge score", () => {
    expect(
      selectBestCandidate([
        candidate("a", "PASS", 0.4),
        candidate("b", "PASS", 0.9),
        candidate("c", "PASS", 0.7),
      ])?.nodeId
    ).toBe("b");
  });

  it("falls back to the first passing candidate when no judge scores", () => {
    expect(
      selectBestCandidate([candidate("a", "PASS"), candidate("b", "PASS")])
        ?.nodeId
    ).toBe("a");
  });
});
