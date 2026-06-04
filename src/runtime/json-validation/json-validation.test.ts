import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseJsonObject,
  parseRuntimeOutput,
  validateJsonSchemaSource,
} from "./json-validation";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-json-validation-"));
  tempDirs.push(dir);
  return dir;
}

describe("json validation runtime helpers", () => {
  it("parses JSON and JSONL runtime output formats", () => {
    expect(parseRuntimeOutput("json", '{"ok":true}')).toEqual({
      output: { ok: true },
    });
    expect(parseRuntimeOutput("jsonl", '{"a":1}\n{"b":2}\n')).toEqual({
      output: [{ a: 1 }, { b: 2 }],
    });
    expect(parseRuntimeOutput("text", "plain")).toEqual({ output: "plain" });
  });

  it("keeps invalid structured output as text with a parse error", () => {
    const result = parseRuntimeOutput("json", "{");

    expect(result.output).toBe("{");
    expect(result.error).toContain("Failed to parse runtime JSON output");
  });

  it("validates JSON values against a schema file", () => {
    const project = tempProject();
    mkdirSync(join(project, "schemas"));
    writeFileSync(
      join(project, "schemas", "result.schema.json"),
      JSON.stringify({
        additionalProperties: false,
        properties: { verdict: { const: "PASS" } },
        required: ["verdict"],
        type: "object",
      })
    );

    expect(
      validateJsonSchemaSource(
        JSON.stringify({ verdict: "PASS" }),
        "schemas/result.schema.json",
        project
      )
    ).toMatchObject({
      evidence: ["JSON schema passed: schemas/result.schema.json"],
      passed: true,
    });
    expect(
      validateJsonSchemaSource(
        JSON.stringify({ verdict: "FAIL" }),
        "schemas/result.schema.json",
        project
      )
    ).toMatchObject({
      passed: false,
      reason: "JSON schema validation failed",
    });
  });

  it("parses objects defensively for runtime aggregate outputs", () => {
    expect(parseJsonObject('{"children":{}}')).toEqual({ children: {} });
    expect(parseJsonObject("[]")).toEqual({});
    expect(parseJsonObject(undefined)).toEqual({});
  });
});
