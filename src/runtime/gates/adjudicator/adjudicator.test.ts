import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  baseGateRuntimeFields,
  gateNodeStateStore,
} from "../../../../tests/gate-test-context";
import { parsePipelineConfigParts } from "../../../config/load";
import { compileWorkflowPlan } from "../../../planning/compile";
import type {
  AcceptanceCriterion,
  ChangedFilesGateSpec,
  CompletionClaim,
  RuntimeContext,
} from "../../contracts";
import type { LlmJudge, LlmJudgeVerdict } from "../adjudication/llm-judge";
import type { GateEvaluationInput } from "../contract";
import type { DeterministicGate } from "./index";
import { adjudicate } from "./index";

const runtimeContext = (): RuntimeContext => {
  const config = parsePipelineConfigParts(
    {
      pipeline:
        'version: 1\ndefault_workflow: smoke\nworkflows:\n  smoke:\n    nodes:\n      - id: check\n        kind: command\n        command: [node, -e, "0"]\n',
      profiles: "version: 1\nprofiles: {}\n",
      runners:
        "version: 1\nrunners:\n  local:\n    type: command\n    command: node\n    capabilities: { native_subagents: false }\n",
    },
    "/tmp/adjudicator-test"
  );
  return {
    ...baseGateRuntimeFields(),
    config,
    nodeStateStore: gateNodeStateStore("node-a", ["README.md"]),
    plan: compileWorkflowPlan(config, "smoke"),
    runId: "run-adjudicator",
    task: "adjudicator layer test",
    workflowId: "smoke",
    worktreePath: process.cwd(),
  };
};

const noopExecutor = {
  execute: () => Effect.succeed({ evidence: [], exitCode: 0, output: "" }),
};

/** A deterministic acceptance gate evaluated over `criteria` with `report` as stdout. */
const acceptanceGate = (
  criteria: AcceptanceCriterion[],
  report: unknown,
  covers: string[]
): DeterministicGate => {
  const input: GateEvaluationInput = {
    attempt: { evidence: [], exitCode: 0, output: JSON.stringify(report) },
    context: {
      ...runtimeContext(),
      taskContext: { acceptanceCriteria: criteria },
    },
    executor: noopExecutor,
    gate: { kind: "acceptance", target: "stdout" },
    gateId: "accept:node-a",
    nodeId: "node-a",
  };
  return { covers, input };
};

/** A binary (non-criterion-aware) deterministic gate that fails: denies any .md change. */
const denyMarkdownGate = (covers: string[]): DeterministicGate => {
  const gate: ChangedFilesGateSpec = {
    changed_files: { deny: ["**/*.md"] },
    id: "changed:node-a",
    kind: "changed_files",
  };
  const input: GateEvaluationInput = {
    attempt: { evidence: [], exitCode: 0, output: "" },
    context: runtimeContext(),
    executor: noopExecutor,
    gate,
    gateId: "changed:node-a",
    nodeId: "node-a",
  };
  return { covers, input };
};

/** A deterministic acceptance gate whose single criterion reports a FAIL verdict. */
const failingAcceptanceGate = (
  criterion: AcceptanceCriterion
): DeterministicGate =>
  acceptanceGate(
    [criterion],
    { acceptance: [{ evidence: ["nope"], id: criterion.id, verdict: "FAIL" }] },
    [criterion.id]
  );

const passReport = (...ids: string[]): unknown => ({
  acceptance: ids.map((id) => ({ evidence: ["ok"], id, verdict: "PASS" })),
});

const verdict = (overrides: Partial<LlmJudgeVerdict>): LlmJudgeVerdict => ({
  citedEvidence: [],
  rationale: "stub",
  satisfied: false,
  ...overrides,
});

const completeClaim = (...ids: string[]): CompletionClaim => ({
  criteria: ids.map((id) => ({ criterion: id, evidence: [`${id} works`] })),
});

const A: AcceptanceCriterion = { id: "A", text: "Alpha" };
const B: AcceptanceCriterion = { id: "B", text: "Beta" };
const C: AcceptanceCriterion = { id: "C", text: "Gamma" };

describe("adjudicate — ordered layers", () => {
  it("all-pass: deterministic passes, claim complete, judge honors anchored residue", async () => {
    const judge = vi.fn<LlmJudge>(() =>
      verdict({
        citedEvidence: ["acceptance coverage passed"],
        satisfied: true,
      })
    );
    const verdictResult = await adjudicate({
      claim: completeClaim("A", "B", "C"),
      criteria: [A, B, C],
      deterministicGates: [
        acceptanceGate([A, B], passReport("A", "B"), ["A", "B"]),
      ],
      judge,
    });
    expect(verdictResult).toEqual({ passed: true, unmet: [] });
    // Only the residue criterion C (not deterministically covered) reaches the judge.
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0]?.[0].criterion).toEqual(C);
  });

  it("deterministic-fail: a failing acceptance gate refuses its covered criterion", async () => {
    const judge = vi.fn<LlmJudge>(() => verdict({ satisfied: true }));
    const result = await adjudicate({
      claim: completeClaim("A"),
      criteria: [A],
      deterministicGates: [failingAcceptanceGate(A)],
      judge,
    });
    expect(result.passed).toBe(false);
    expect(result.unmet).toEqual([
      {
        criterion: "A",
        evidence: ["reported verdict 'FAIL'"],
        reason: "acceptance criterion 'A' verdict 'FAIL'",
      },
    ]);
    // A is deterministically covered, so the judge is never consulted for it.
    expect(judge).not.toHaveBeenCalled();
  });

  it("deterministic-fail (binary gate): synthesizes an unmet entry per covered criterion", async () => {
    const judge = vi.fn<LlmJudge>(() => verdict({ satisfied: true }));
    const result = await adjudicate({
      claim: completeClaim("A"),
      criteria: [A],
      deterministicGates: [denyMarkdownGate(["A"])],
      judge,
    });
    expect(result.passed).toBe(false);
    expect(result.unmet).toEqual([
      {
        criterion: "A",
        evidence: ["denied changes: README.md"],
        reason: "changed-file policy failed",
      },
    ]);
    expect(judge).not.toHaveBeenCalled();
  });

  it("claim-incomplete: structured-claim refuses a criterion missing from the claim", async () => {
    const judge = vi.fn<LlmJudge>(() => verdict({ satisfied: true }));
    const result = await adjudicate({
      claim: { criteria: [] },
      criteria: [A],
      judge,
    });
    expect(result.passed).toBe(false);
    expect(result.unmet).toEqual([
      {
        criterion: "A",
        evidence: [],
        reason: "no claim entry for criterion 'A'",
      },
    ]);
    // A is already settled unmet by structured-claim, so it never reaches the judge.
    expect(judge).not.toHaveBeenCalled();
  });

  it("judge-residue: an un-encodable criterion is settled only by the injected judge", async () => {
    const judge = vi.fn<LlmJudge>(() =>
      verdict({ citedEvidence: ["det: build green"], satisfied: false })
    );
    const result = await adjudicate({
      claim: completeClaim("A"),
      criteria: [A],
      // contributes evidence-less failure, covers nothing
      deterministicGates: [denyMarkdownGate([])],
      judge,
    });
    // denyMarkdownGate covers nothing -> A is residue; judge refuses it.
    expect(result.unmet.map((u) => u.criterion)).toContain("A");
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it("judge is never standalone-authoritative: an unanchored pass stays unmet (empty evidence pool)", async () => {
    const judge = vi.fn<LlmJudge>(() =>
      verdict({ citedEvidence: ["invented"], satisfied: true })
    );
    const result = await adjudicate({
      claim: completeClaim("A"),
      criteria: [A],
      judge,
    });
    expect(result.passed).toBe(false);
    expect(result.unmet.map((u) => u.criterion)).toEqual(["A"]);
    expect(result.unmet[0]?.reason).toContain(
      "not present in the deterministic"
    );
  });
});

describe("adjudicate — aggregation across layers (AC#2)", () => {
  it("aggregates EVERY distinct unmet criterion spanning all three layers", async () => {
    const judge: LlmJudge = (input) =>
      input.criterion.id === "C"
        ? verdict({
            citedEvidence: ["acceptance coverage passed"],
            satisfied: false,
          })
        : verdict({
            citedEvidence: ["acceptance coverage passed"],
            satisfied: true,
          });
    const result = await adjudicate({
      // A: deterministic-fail. B: missing from claim (structured). C: judge refuses.
      claim: { criteria: [{ criterion: "C", evidence: ["c works"] }] },
      criteria: [A, B, C],
      deterministicGates: [failingAcceptanceGate(A)],
      judge,
    });
    expect(result.passed).toBe(false);
    expect(result.unmet.map((u) => u.criterion).toSorted()).toEqual([
      "A",
      "B",
      "C",
    ]);
    const byId = new Map(result.unmet.map((u) => [u.criterion, u.reason]));
    // deterministic layer
    expect(byId.get("A")).toContain("verdict 'FAIL'");
    // structured-claim layer
    expect(byId.get("B")).toContain("no claim entry");
    // judge layer
    expect(byId.get("C")).toContain(
      "marked the residual criterion unsatisfied"
    );
  });

  it("dedupes a criterion failing multiple layers, keeping the earliest (deterministic) reason", async () => {
    const judge = vi.fn<LlmJudge>(() => verdict({ satisfied: true }));
    const result = await adjudicate({
      // A is covered by a failing deterministic gate AND absent from the claim
      // (which structured-claim would also flag): it must appear exactly once.
      claim: { criteria: [] },
      criteria: [A],
      deterministicGates: [failingAcceptanceGate(A)],
      judge,
    });
    expect(result.unmet).toHaveLength(1);
    expect(result.unmet[0]?.criterion).toBe("A");
    // deterministic wins
    expect(result.unmet[0]?.reason).toContain("verdict 'FAIL'");
  });
});
