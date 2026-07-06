import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseWithSchema } from "../../schema-boundary";
import type { PipelineRuntimeEvent } from "../contracts";
import {
  applyGoalStateEvent,
  createGoalState,
  goalStateArtifactPath,
  goalStateCompletionEvidence,
  goalStateContinuationInput,
  loadGoalState,
  loadGoalStateFromRunDirectory,
  markGoalStateBlocked,
  parseGoalState,
  pipelineGoalStateSchema,
  reconstructGoalStateFromEvents,
  recordGoalStateChangedFiles,
  recordGoalStateContinuationAttempt,
  saveGoalState,
} from "./goal-state";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tempDirs.length = 0;
});

const baseState = () =>
  createGoalState({
    runId: "run-1",
    task: "Ship PIPE-52",
    workflowId: "root",
  });

const applyEvents = (
  events: PipelineRuntimeEvent[],
  taskContext?: Parameters<typeof createGoalState>[0]["taskContext"],
) =>
  reconstructGoalStateFromEvents(
    {
      runId: "run-1",
      task: "Ship PIPE-52",
      ...(taskContext ? { taskContext } : {}),
      workflowId: "root",
    },
    events,
  );

describe("pipeline goal state", () => {
  it("creates and validates initial state with task, schedule, and workflow metadata", () => {
    const state = createGoalState({
      runId: "run-1",
      scheduleId: "schedule-1",
      schedulePath: ".pipeline/runs/run-1/schedule.yaml",
      task: "Ship PIPE-52",
      taskContext: {
        acceptanceCriteria: [{ id: "AC1", text: "It works" }],
        id: "PIPE-52",
        title: "OpenCode first",
      },
      workflowId: "root",
    });

    expect(state).toMatchObject({
      runId: "run-1",
      schedule: {
        id: "schedule-1",
        path: ".pipeline/runs/run-1/schedule.yaml",
      },
      task: {
        context: expect.objectContaining({ id: "PIPE-52" }),
        original: "Ship PIPE-52",
      },
      version: 1,
      workflowId: "root",
    });
    expect(parseWithSchema(pipelineGoalStateSchema, state)).toEqual(state);
  });

  it("updates node attempts and gate failures from runtime events", () => {
    const state = applyEvents([
      {
        edges: [],
        nodes: [
          {
            id: "verify",
            kind: "agent",
            needs: [],
            profile: "moka-verifier",
            runnerId: "opencode",
          },
        ],
        type: "workflow.planned",
        workflowId: "root",
      },
      {
        attempt: 1,
        nodeId: "verify",
        profile: "moka-verifier",
        runnerId: "opencode",
        type: "node.start",
      },
      {
        evidence: ["verdict expected PASS"],
        gateId: "verify-verdict",
        kind: "verdict",
        nodeId: "verify",
        passed: false,
        reason: "verdict requirement failed",
        type: "gate.finish",
      },
      {
        attempt: 1,
        exitCode: 1,
        nodeId: "verify",
        profile: "moka-verifier",
        runnerId: "opencode",
        status: "failed",
        type: "node.finish",
      },
    ]);

    expect(state.nodes.verify).toMatchObject({
      attempts: 1,
      exitCode: 1,
      profile: "moka-verifier",
      runnerId: "opencode",
      status: "failed",
    });
    expect(state.gateFailures).toEqual([
      expect.objectContaining({
        gateId: "verify-verdict",
        nodeId: "verify",
        passed: false,
      }),
    ]);
    expect(state.verifier).toMatchObject({
      nodeId: "verify",
      reason: "verdict requirement failed",
      verdict: "FAIL",
    });
  });

  it("records verifier verdicts without storing raw runner output", () => {
    const state = applyEvents([
      {
        attempt: 1,
        format: "json_schema",
        nodeId: "verify",
        output: {
          evidence: ["typecheck passed"],
          noisy: "x".repeat(10_000),
          verdict: "PASS",
        },
        profile: "moka-verifier",
        schemaPath: ".pipeline/schemas/verify.schema.json",
        type: "node.output.recorded",
      },
    ]);

    expect(state.verifier).toEqual({
      evidence: ["typecheck passed"],
      nodeId: "verify",
      verdict: "PASS",
    });
    expect(JSON.stringify(state)).not.toContain("noisy");
  });

  it("records verifier and criterion violation details for continuation input", () => {
    const state = applyEvents([
      {
        attempt: 1,
        format: "json_schema",
        nodeId: "acceptance",
        output: {
          acceptance: [
            {
              evidence: ["AC1 is covered"],
              id: "AC1",
              verdict: "PASS",
            },
            {
              evidence: ["AC2 is missing"],
              id: "AC2",
              verdict: "FAIL",
              violations: ["missing CLI coverage"],
            },
          ],
          evidence: ["acceptance review ran"],
          verdict: "FAIL",
        },
        profile: "moka-acceptance-reviewer",
        schemaPath: ".pipeline/schemas/acceptance.schema.json",
        type: "node.output.recorded",
      },
      {
        attempt: 1,
        format: "json_schema",
        nodeId: "verify",
        output: {
          evidence: ["typecheck passed but tests missing"],
          verdict: "FAIL",
          violations: ["missing real CLI smoke"],
        },
        profile: "moka-verifier",
        schemaPath: ".pipeline/schemas/verify.schema.json",
        type: "node.output.recorded",
      },
      {
        evidence: ["verdict expected PASS"],
        gateId: "verify-verdict",
        kind: "verdict",
        nodeId: "verify",
        passed: false,
        reason: "verdict requirement failed",
        type: "gate.finish",
      },
      {
        attempt: 1,
        exitCode: 1,
        nodeId: "verify",
        profile: "moka-verifier",
        runnerId: "opencode",
        status: "failed",
        type: "node.finish",
      },
    ]);

    expect(state.acceptance[1]).toMatchObject({
      id: "AC2",
      violations: ["missing CLI coverage"],
    });
    expect(state.verifier).toMatchObject({
      verdict: "FAIL",
      violations: ["missing real CLI smoke"],
    });
    expect(goalStateContinuationInput(state)).toMatchObject({
      currentNodeId: "verify",
      exactNextRequirement: "Satisfy failed acceptance criteria: AC2.",
      failureSignature: expect.stringContaining("missing real CLI smoke"),
      verifier: expect.objectContaining({
        violations: ["missing real CLI smoke"],
      }),
    });
  });

  it("records acceptance verdicts and acceptance failures", () => {
    const state = applyEvents([
      {
        attempt: 1,
        format: "json_schema",
        nodeId: "acceptance",
        output: {
          acceptance: [
            { evidence: ["done"], id: "AC1", verdict: "PASS" },
            { evidence: ["missing"], id: "AC2", verdict: "FAIL" },
          ],
          verdict: "FAIL",
        },
        profile: "moka-acceptance-reviewer",
        schemaPath: ".pipeline/schemas/acceptance.schema.json",
        type: "node.output.recorded",
      },
      {
        evidence: ["acceptance criterion 'AC2' verdict 'FAIL'"],
        gateId: "acceptance-coverage",
        kind: "acceptance",
        nodeId: "acceptance",
        passed: false,
        reason: "acceptance coverage failed",
        type: "gate.finish",
      },
    ]);

    expect(state.acceptance).toEqual([
      { evidence: ["done"], id: "AC1", verdict: "PASS" },
      { evidence: ["missing"], id: "AC2", verdict: "FAIL" },
    ]);
    expect(state.gateFailures).toContainEqual(
      expect.objectContaining({
        gateId: "acceptance-coverage",
        kind: "acceptance",
        reason: "acceptance coverage failed",
      }),
    );
  });

  it("requires deterministic verifier and acceptance evidence before completion passes", () => {
    const noVerifier = applyGoalStateEvent(baseState(), {
      outcome: "PASS",
      type: "workflow.finish",
      workflowId: "root",
    });
    expect(goalStateCompletionEvidence(noVerifier)).toMatchObject({
      evidence: expect.arrayContaining(["missing passing verifier evidence"]),
      passed: false,
    });

    const withEvidence = applyEvents(
      [
        {
          attempt: 1,
          format: "json_schema",
          nodeId: "acceptance",
          output: {
            acceptance: [{ evidence: ["accepted"], id: "AC1", verdict: "PASS" }],
            evidence: ["acceptance passed"],
            verdict: "PASS",
          },
          profile: "moka-acceptance-reviewer",
          schemaPath: ".pipeline/schemas/acceptance.schema.json",
          type: "node.output.recorded",
        },
        {
          attempt: 1,
          format: "json_schema",
          nodeId: "verify",
          output: {
            evidence: ["verification passed"],
            verdict: "PASS",
          },
          profile: "moka-verifier",
          schemaPath: ".pipeline/schemas/verify.schema.json",
          type: "node.output.recorded",
        },
        {
          outcome: "PASS",
          type: "workflow.finish",
          workflowId: "root",
        },
      ],
      {
        acceptanceCriteria: [{ id: "AC1", text: "It works" }],
      },
    );

    expect(goalStateCompletionEvidence(withEvidence)).toMatchObject({
      passed: true,
    });
  });

  it("records pass, cancelled, blocked, changed files, and continuation attempts", () => {
    const passed = applyGoalStateEvent(baseState(), {
      outcome: "PASS",
      type: "workflow.finish",
      workflowId: "root",
    });
    expect(passed.terminalOutcome).toBe("PASS");

    const cancelled = applyGoalStateEvent(baseState(), {
      outcome: "CANCELLED",
      type: "workflow.finish",
      workflowId: "root",
    });
    expect(cancelled.terminalOutcome).toBe("CANCELLED");

    const withFiles = recordGoalStateChangedFiles(baseState(), "green", ["src/a.ts", "src/a.ts", "tests/a.test.ts"]);
    expect(withFiles.changedFiles).toEqual(["src/a.ts", "tests/a.test.ts"]);
    expect(withFiles.nodes.green.changedFiles).toEqual(["src/a.ts", "tests/a.test.ts"]);

    const continued = recordGoalStateContinuationAttempt(withFiles, {
      promptPath: ".pipeline/runs/run-1/continue-1.md",
      reason: "verifier requested fixes",
      verifierNodeId: "verify",
    });
    expect(continued.continuationAttempts).toEqual([
      {
        attempt: 1,
        promptPath: ".pipeline/runs/run-1/continue-1.md",
        reason: "verifier requested fixes",
        verifierNodeId: "verify",
      },
    ]);

    const blocked = markGoalStateBlocked(continued, "same failure repeated");
    expect(blocked.terminalOutcome).toBe("BLOCKED");
    expect(blocked.blockedReasons).toEqual(["same failure repeated"]);
  });

  it("preserves sorted non-empty unique changed files across goal and node state", () => {
    const state = recordGoalStateChangedFiles(baseState(), "green", [
      "tests/schema.test.ts",
      "",
      "src/b.ts",
      "src/a.ts",
      "src/b.ts",
    ]);
    const updated = recordGoalStateChangedFiles(state, "green", ["tests/a.test.ts", "src/a.ts"]);

    expect(updated.changedFiles).toEqual(["src/a.ts", "src/b.ts", "tests/a.test.ts", "tests/schema.test.ts"]);
    expect(updated.nodes.green.changedFiles).toEqual([
      "src/a.ts",
      "src/b.ts",
      "tests/a.test.ts",
      "tests/schema.test.ts",
    ]);
  });

  it("reconstructs state from events and loads the run artifact goal-state.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "pipeline-goal-state-"));
    tempDirs.push(dir);
    mkdirSync(dir, { recursive: true });

    const reconstructed = reconstructGoalStateFromEvents(
      {
        runId: "run-1",
        task: "Ship",
        workflowId: "root",
      },
      [
        {
          attempt: 1,
          nodeId: "verify",
          profile: "moka-verifier",
          runnerId: "opencode",
          type: "node.start",
        },
        {
          attempt: 1,
          exitCode: 0,
          nodeId: "verify",
          profile: "moka-verifier",
          runnerId: "opencode",
          status: "passed",
          type: "node.finish",
        },
        { outcome: "PASS", type: "workflow.finish", workflowId: "root" },
      ],
    );

    saveGoalState(reconstructed, dir);

    expect(goalStateArtifactPath(dir)).toBe(join(dir, "goal-state.json"));
    expect(loadGoalState(goalStateArtifactPath(dir))).toEqual(reconstructed);
    expect(loadGoalStateFromRunDirectory(dir)).toEqual(reconstructed);
  });

  it("rejects corrupt state", () => {
    expect(() => parseGoalState({ task: { original: "missing workflow" }, version: 1 })).toThrow();

    const dir = mkdtempSync(join(tmpdir(), "pipeline-goal-state-bad-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "goal-state.json"), '{"version":2}\n');

    expect(() => loadGoalStateFromRunDirectory(dir)).toThrow();
  });
});
