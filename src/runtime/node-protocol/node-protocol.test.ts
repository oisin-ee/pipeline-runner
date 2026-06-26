import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AcceptanceCriterion, RuntimeNodeResult } from "../contracts";
import {
  type NextNodeEnvelope,
  nextNodeEnvelopeSchema,
  parseNextNodeEnvelope,
  parseSubmitResult,
  type SubmitResult,
  submitResultSchema,
} from "./node-protocol";

// A representative envelope for one node: a prompt, two read-only acceptance
// criteria, and two upstream dependency outputs.
function sampleEnvelope(): NextNodeEnvelope {
  return {
    criteria: [
      { id: "ac-1", text: "compiles" },
      { id: "ac-2", text: "tests pass" },
    ],
    nodeId: "implement",
    prompt: "Implement the feature described by the criteria.",
    runId: "run-123",
    upstreamOutputs: [
      { nodeId: "plan", output: "plan summary" },
      { nodeId: "scaffold", output: "scaffold summary" },
    ],
  };
}

function sampleResult(): RuntimeNodeResult {
  return {
    attempts: 1,
    evidence: ["pnpm test: 0"],
    exitCode: 0,
    nodeId: "implement",
    output: "done",
    status: "passed",
  };
}

function sampleSubmit(): SubmitResult {
  return { nodeId: "implement", result: sampleResult(), runId: "run-123" };
}

// JSON round-trip: serialize, re-parse the raw JSON text, validate via schema.
function roundTrip<T>(schema: z.ZodType<T>, value: T): T {
  return schema.parse(JSON.parse(JSON.stringify(value)));
}

describe("NextNodeEnvelope", () => {
  it("round-trips through JSON including criteria and upstream outputs (AC#1)", () => {
    const envelope = sampleEnvelope();
    expect(roundTrip(nextNodeEnvelopeSchema, envelope)).toEqual(envelope);
  });

  it("carries prompt, read-only criteria, and upstream outputs for one node (AC#2)", () => {
    // Build the envelope from a node + its dependency results, as `next node`
    // will: prompt + the node's own criteria + each upstream node's output.
    const nodeId = "implement";
    const runId = "run-123";
    const prompt = "Implement the feature.";
    const criteria: AcceptanceCriterion[] = [{ id: "ac-1", text: "compiles" }];
    const upstream: RuntimeNodeResult[] = [
      { ...sampleResult(), nodeId: "plan", output: "plan summary" },
    ];
    const envelope = parseNextNodeEnvelope({
      criteria,
      nodeId,
      prompt,
      runId,
      upstreamOutputs: upstream.map((result) => ({
        nodeId: result.nodeId,
        output: result.output,
      })),
    });

    expect(envelope.prompt).toBe(prompt);
    expect(envelope.runId).toBe(runId);
    expect(envelope.nodeId).toBe(nodeId);
    expect(envelope.criteria).toEqual(criteria);
    expect(envelope.upstreamOutputs).toEqual([
      { nodeId: "plan", output: "plan summary" },
    ]);
  });

  it("freezes criteria so the executing agent cannot mutate them (decision #7)", () => {
    const envelope = parseNextNodeEnvelope(sampleEnvelope());
    expect(Object.isFrozen(envelope.criteria[0])).toBe(true);
  });

  it("rejects an unknown key with a structured error", () => {
    const result = nextNodeEnvelopeSchema.safeParse({
      ...sampleEnvelope(),
      extra: "nope",
    });
    expect(result.success).toBe(false);
  });
});

describe("SubmitResult", () => {
  it("round-trips a RuntimeNodeResult keyed (runId, nodeId) through JSON (AC#1)", () => {
    const submit = sampleSubmit();
    expect(roundTrip(submitResultSchema, submit)).toEqual(submit);
  });

  it("rejects a result missing required fields with a structured error (AC#3)", () => {
    const malformed = {
      nodeId: "implement",
      result: { nodeId: "implement", output: "done", status: "passed" },
      runId: "run-123",
    };
    const result = submitResultSchema.safeParse(malformed);

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected malformed submit to be rejected");
    }
    expect(result.error).toBeInstanceOf(z.ZodError);
    const missing = result.error.issues.map((issue) => issue.path.join("."));
    expect(missing).toContain("result.attempts");
    expect(missing).toContain("result.evidence");
    expect(missing).toContain("result.exitCode");
  });

  it("rejects a (runId, nodeId) key mismatch with a structured error (AC#3)", () => {
    expect(() =>
      parseSubmitResult({
        nodeId: "implement",
        result: { ...sampleResult(), nodeId: "other" },
        runId: "run-123",
      })
    ).toThrow(z.ZodError);
  });
});
