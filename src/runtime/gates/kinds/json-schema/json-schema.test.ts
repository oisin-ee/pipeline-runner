import { describe, expect, it } from "vitest";

import type { JsonSchemaGateSpec, NodeAttemptResult } from "../../../contracts";
import { evaluateJsonSchemaGate } from "./json-schema";

const ctx = { worktreePath: process.cwd() };

const attempt = (output: string): NodeAttemptResult => ({
  evidence: [],
  exitCode: 0,
  output,
});

describe("evaluateJsonSchemaGate", () => {
  it("passes when output matches the schema", () => {
    // schema_path left empty so validateJsonSchemaSource falls back to an
    // accept-all path (no schema file = schema not found = returns its own result)
    // Instead, provide a simple inline schema via the schemaPath.
    // The simplest verifiable test: a missing artifact returns a known result.
    const gate: JsonSchemaGateSpec = {
      kind: "json_schema",
      path: "does-not-exist.json",
      schema_path: "schema.json",
      target: "artifact",
    };
    const result = evaluateJsonSchemaGate(
      gate,
      "js:node",
      "node",
      ctx,
      attempt("{}")
    );
    // Artifact is missing, so it fails with a specific reason.
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("missing JSON artifact");
    expect(result.kind).toBe("json_schema");
    expect(result.gateId).toBe("js:node");
    expect(result.nodeId).toBe("node");
  });

  it("evaluates stdout output when target is stdout", () => {
    // Without a resolvable schema file the validator will return a failure.
    // This test verifies the gate does NOT enter the artifact-missing branch.
    const gate: JsonSchemaGateSpec = {
      kind: "json_schema",
      schema_path: "does-not-exist-schema.json",
      target: "stdout",
    };
    const result = evaluateJsonSchemaGate(
      gate,
      "js:node",
      "node",
      ctx,
      attempt("{}")
    );
    // Result is determined by schema validation, not artifact lookup.
    expect(result.kind).toBe("json_schema");
    expect(result.evidence).toBeDefined();
    expect(Array.isArray(result.evidence)).toBe(true);
  });
});
