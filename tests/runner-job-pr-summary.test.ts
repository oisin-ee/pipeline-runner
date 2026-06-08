import { describe, expect, it } from "vitest";
import type { PipelineRuntimeResult } from "../src/pipeline-runtime";
import { renderRunnerPullRequestSummary } from "../src/runner-job/pr-summary";
import type { RunnerJobPayload } from "../src/runner-job-contract";

const VALIDATED_IMPLEMENTATION_CHANGE_RE = /validated implementation change/;

function payload(): RunnerJobPayload {
  return {
    contractVersion: "1",
    delivery: { pullRequest: true },
    events: {
      authHeader: "Authorization",
      authTokenFile: "/tmp/event-token",
      url: "https://console.example.test/events",
    },
    repository: {
      baseBranch: "main",
      url: "https://github.com/oisin-ee/rondo.git",
    },
    run: {
      id: "run_123",
      project: "project_123",
    },
    task: {
      id: "RONDO-12",
      kind: "ticket",
      title: "Add member search",
    },
  };
}

function runtimeResult(
  structuredOutputs: PipelineRuntimeResult["structuredOutputs"]
): PipelineRuntimeResult {
  return {
    agentInvocations: [],
    failureDetails: [],
    gates: [],
    hookFailures: [],
    nodeStates: {},
    nodes: [],
    outcome: "PASS",
    plan: {
      workflowId: "schedule-run_123-root",
    } as PipelineRuntimeResult["plan"],
    structuredOutputs,
  };
}

describe("runner PR summary renderer", () => {
  it("renders validated implementation changes with why, verification, and metadata", () => {
    const summary = renderRunnerPullRequestSummary({
      metadata: {
        branch: "pipeline/rondo-12",
        commitSha: "abc123",
        orchestrator: "codex",
        scheduleId: "run_123",
        schedulePath: ".pipeline/runs/run_123/schedule.yaml",
      },
      payload: payload(),
      result: runtimeResult([
        {
          attempt: 1,
          format: "json_schema",
          nodeId: "implement.green",
          output: {
            changes: [
              {
                files: ["src/search.ts"],
                summary: "Add member search endpoint",
                why: "Members need a direct way to find records",
              },
            ],
            risks: ["Search indexing may need follow-up tuning"],
            verification: ["bun run test tests/search.test.ts"],
          },
          parentParallelNodeId: "implement",
          profileId: "pipeline-code-writer",
          schemaPath: ".pipeline/schemas/implementation.schema.json",
          validation: {
            evidence: [
              "JSON schema passed: .pipeline/schemas/implementation.schema.json",
            ],
            passed: true,
            status: "valid",
          },
        },
      ]),
    });

    expect(summary.title).toBe("Pipeline: Add member search");
    expect(summary.body).toContain("## Changes");
    expect(summary.body).toContain("- Add member search endpoint");
    expect(summary.body).toContain(
      "Why: Members need a direct way to find records"
    );
    expect(summary.body).toContain("Files: src/search.ts");
    expect(summary.body).toContain("bun run test tests/search.test.ts");
    expect(summary.body).toContain("Run ID: run_123");
    expect(summary.body).toContain(
      "Schedule Path: .pipeline/runs/run_123/schedule.yaml"
    );
    expect(summary.body).toContain("Branch: pipeline/rondo-12");
    expect(summary.body).toContain("Commit: abc123");
  });

  it("refuses to render when no validated implementation changes exist", () => {
    expect(() =>
      renderRunnerPullRequestSummary({
        metadata: {
          branch: "pipeline/rondo-12",
          commitSha: null,
          orchestrator: "codex",
          scheduleId: "run_123",
          schedulePath: ".pipeline/runs/run_123/schedule.yaml",
        },
        payload: payload(),
        result: runtimeResult([
          {
            attempt: 1,
            format: "json_schema",
            nodeId: "verify",
            output: { evidence: ["tests passed"], verdict: "PASS" },
            profileId: "pipeline-verifier",
            schemaPath: ".pipeline/schemas/verify.schema.json",
            validation: { evidence: [], passed: true, status: "valid" },
          },
        ]),
      })
    ).toThrow(VALIDATED_IMPLEMENTATION_CHANGE_RE);
  });
});
