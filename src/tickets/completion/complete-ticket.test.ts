import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { baseGateRuntimeFields, gateNodeStateStore } from "../../../tests/gate-test-context";
import { parsePipelineConfigParts } from "../../config/load";
import { compileWorkflowPlan } from "../../planning/compile";
import type { AcceptanceCriterion, CompletionClaim, RuntimeContext } from "../../runtime/contracts";
import type { LlmJudge } from "../../runtime/gates/adjudication/llm-judge";
import type { DeterministicGate } from "../../runtime/gates/adjudicator";
import type { GateEvaluationInput } from "../../runtime/gates/contract";
import { completeTicket, conservativeLayerAJudge, TicketCompletionError } from "./complete-ticket";
import type { TicketCompletionStore, TicketCompletionTarget } from "./complete-ticket";

const A: AcceptanceCriterion = { id: "1", text: "Alpha" };

const recordingStore = (target: TicketCompletionTarget, markDoneCalls: string[]): TicketCompletionStore => ({
  loadTarget: () => Effect.succeed(target),
  markDone: (ticketId) =>
    Effect.sync(() => {
      markDoneCalls.push(ticketId);
    }),
});

const claimFor = (...ids: string[]): CompletionClaim => ({
  criteria: ids.map((id) => ({ criterion: id, evidence: [`${id} works`] })),
});

const runtimeContext = (): RuntimeContext => {
  const config = parsePipelineConfigParts(
    {
      pipeline:
        'version: 1\ndefault_workflow: smoke\nworkflows:\n  smoke:\n    nodes:\n      - id: check\n        kind: command\n        command: [node, -e, "0"]\n',
      profiles: "version: 1\nprofiles: {}\n",
      runners:
        "version: 1\nrunners:\n  local:\n    type: command\n    command: node\n    capabilities: { native_subagents: false }\n",
    },
    "/tmp/complete-ticket-test",
  );
  return {
    ...baseGateRuntimeFields(),
    config,
    nodeStateStore: gateNodeStateStore("node-a", ["README.md"]),
    plan: compileWorkflowPlan(config, "smoke"),
    runId: "run-complete-ticket",
    task: "complete-ticket layer test",
    workflowId: "smoke",
    worktreePath: process.cwd(),
  };
};

/** A passing deterministic acceptance gate that covers `criterion`. */
const passingAcceptanceGate = (criterion: AcceptanceCriterion): DeterministicGate => {
  const input: GateEvaluationInput = {
    attempt: {
      evidence: [],
      exitCode: 0,
      output: JSON.stringify({
        acceptance: [{ evidence: ["ok"], id: criterion.id, verdict: "PASS" }],
      }),
    },
    context: {
      ...runtimeContext(),
      taskContext: { acceptanceCriteria: [criterion] },
    },
    executor: {
      execute: () => Effect.succeed({ evidence: [], exitCode: 0, output: "" }),
    },
    gate: { kind: "acceptance", target: "stdout" },
    gateId: "accept:node-a",
    nodeId: "node-a",
  };
  return { covers: [criterion.id], input };
};

describe("completeTicket", () => {
  it("refuses without marking Done when the conservative judge cannot honor a residue criterion", async () => {
    const markDoneCalls: string[] = [];
    const store = recordingStore({ criteria: [A], id: "PIPE-1" }, markDoneCalls);

    const outcome = await Effect.runPromise(
      completeTicket({
        claim: claimFor("1"),
        judge: conservativeLayerAJudge,
        store,
        ticketId: "PIPE-1",
      }),
    );

    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") {
      throw new Error("expected refusal");
    }
    expect(outcome.unmet).toHaveLength(1);
    expect(outcome.unmet[0]?.criterion).toBe("1");
    expect(markDoneCalls).toEqual([]);
  });

  it("marks Done on an adjudicator pass with no declared criteria", async () => {
    const markDoneCalls: string[] = [];
    const store = recordingStore({ criteria: [], id: "PIPE-1" }, markDoneCalls);
    const judge = vi.fn<LlmJudge>(() => {
      throw new Error("judge must not be consulted when there is no residue");
    });

    const outcome = await Effect.runPromise(
      completeTicket({
        claim: { criteria: [] },
        judge,
        store,
        ticketId: "PIPE-1",
      }),
    );

    expect(outcome).toEqual({ status: "completed", ticketId: "PIPE-1" });
    expect(markDoneCalls).toEqual(["PIPE-1"]);
    expect(judge).not.toHaveBeenCalled();
  });

  it("marks Done on an adjudicator pass driven by a passing deterministic gate", async () => {
    const markDoneCalls: string[] = [];
    const store = recordingStore({ criteria: [A], id: "PIPE-1" }, markDoneCalls);
    const judge = vi.fn<LlmJudge>(() => {
      throw new Error("judge must not be consulted for a covered criterion");
    });

    const outcome = await Effect.runPromise(
      completeTicket({
        claim: claimFor("1"),
        deterministicGates: [passingAcceptanceGate(A)],
        judge,
        store,
        ticketId: "PIPE-1",
      }),
    );

    expect(outcome).toEqual({ status: "completed", ticketId: "PIPE-1" });
    expect(markDoneCalls).toEqual(["PIPE-1"]);
    expect(judge).not.toHaveBeenCalled();
  });

  it("fails when the ticket cannot be loaded", async () => {
    const store: TicketCompletionStore = {
      loadTarget: (ticketId) =>
        Effect.fail(
          new TicketCompletionError({
            message: `Unknown Backlog ticket '${ticketId}'`,
          }),
        ),
      markDone: () => Effect.void,
    };

    const exit = await Effect.runPromiseExit(
      completeTicket({
        claim: { criteria: [] },
        judge: conservativeLayerAJudge,
        store,
        ticketId: "PIPE-404",
      }),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("conservativeLayerAJudge never honors a criterion", () => {
    const verdict = conservativeLayerAJudge({
      claimedEvidence: ["done"],
      criterion: A,
      deterministicEvidence: [],
    });
    expect(verdict.satisfied).toBe(false);
    expect(verdict.citedEvidence).toEqual([]);
  });
});
