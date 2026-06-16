import { describe, expect, it } from "vitest";
import type { PlannedWorkflowNode } from "../../planning/compile";
import type { RuntimeContext } from "../contracts";
import {
  type Candidate,
  executeSelectCandidateBuiltin,
  selectBestCandidate,
} from "./select-candidate";

function candidate(
  nodeId: string,
  status: "FAIL" | "PASS",
  judgeScore: number | null = null
): Candidate {
  return { judgeScore, nodeId, output: `out-${nodeId}`, status };
}

// Build the minimal RuntimeContext executeSelectCandidateBuiltin reads: the
// candidates parallel node (with children) from the plan graph, and the
// parallel's aggregate `{children: {<childId>: <output>}}` from the state store.
function contextWithCandidates(
  children: Record<string, string>
): RuntimeContext {
  const candidatesId = "green-candidates";
  return {
    config: {
      best_of_n: { categories: ["green"], enabled: true, n: 2 },
      runners: {},
    },
    nodeStateStore: {
      getOutput: (id: string) =>
        id === candidatesId ? JSON.stringify({ children }) : "",
    },
    plan: {
      graph: {
        node: (id: string) =>
          id === candidatesId
            ? { children: Object.keys(children).map((cid) => ({ id: cid })) }
            : undefined,
      },
    },
  } as unknown as RuntimeContext;
}

const SELECT_NODE = { needs: ["green-candidates"] } as PlannedWorkflowNode;

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

describe("executeSelectCandidateBuiltin (end-to-end candidate selection)", () => {
  it("reads the candidates parallel, selects the passing one, and emits its output", async () => {
    const ctx = contextWithCandidates({
      "green-c1": JSON.stringify({ verdict: "FAIL" }),
      "green-c2": JSON.stringify({ result: "ok", value: 42 }),
    });

    const result = await executeSelectCandidateBuiltin(ctx, SELECT_NODE);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toEqual({ result: "ok", value: 42 });
    expect(result.evidence.join(" ")).toContain("selected 'green-c2'");
  });

  it("fails with evidence when no candidate passes", async () => {
    const ctx = contextWithCandidates({
      "green-c1": JSON.stringify({ status: "FAIL" }),
      "green-c2": JSON.stringify({ verdict: "FAIL" }),
    });

    const result = await executeSelectCandidateBuiltin(ctx, SELECT_NODE);

    expect(result.exitCode).toBe(1);
    expect(result.evidence.join(" ")).toContain("no passing candidate");
  });
});
