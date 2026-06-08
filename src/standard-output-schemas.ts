import { z } from "zod";

const VERDICT_SCHEMA = z.enum(["PASS", "FAIL"]);
const STRING_ARRAY_SCHEMA = z.array(z.string());

const CHANGE_SCHEMA = z
  .object({
    files: z.array(z.string().min(1)).min(1),
    summary: z.string().min(1),
    why: z.string().min(1),
  })
  .strict();

const STANDARD_OUTPUT_SCHEMAS = {
  acceptance: z
    .object({
      acceptance: z.array(
        z
          .object({
            evidence: STRING_ARRAY_SCHEMA,
            id: z.string(),
            violations: STRING_ARRAY_SCHEMA.optional(),
            verdict: VERDICT_SCHEMA,
          })
          .strict()
      ),
      evidence: STRING_ARRAY_SCHEMA,
      verdict: VERDICT_SCHEMA,
      violations: STRING_ARRAY_SCHEMA.optional(),
    })
    .strict(),
  implementation: z
    .object({
      changes: z.array(CHANGE_SCHEMA).min(1),
      followups: STRING_ARRAY_SCHEMA.optional(),
      lessons: STRING_ARRAY_SCHEMA.optional(),
      risks: STRING_ARRAY_SCHEMA.optional(),
      summary: z.string().optional(),
      verification: STRING_ARRAY_SCHEMA,
    })
    .strict(),
  learn: z
    .object({
      evidence: STRING_ARRAY_SCHEMA,
      qdrant: z
        .object({
          attempted: z.boolean(),
          succeeded: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  research: z
    .object({
      ac: STRING_ARRAY_SCHEMA,
      files: STRING_ARRAY_SCHEMA.optional(),
      findings: STRING_ARRAY_SCHEMA,
      risks: STRING_ARRAY_SCHEMA.optional(),
      target: z.string().optional(),
    })
    .strict(),
  review: z
    .object({
      findings: z.array(
        z
          .object({
            file: z.string().optional(),
            line: z.number().int().min(1).optional(),
            message: z.string(),
            rule: z.string().optional(),
            severity: z.enum(["info", "warn", "error", "critical"]),
          })
          .strict()
      ),
      summary: z.string().optional(),
      verdict: VERDICT_SCHEMA,
    })
    .strict(),
  verify: z
    .object({
      evidence: STRING_ARRAY_SCHEMA,
      verdict: VERDICT_SCHEMA,
      violations: STRING_ARRAY_SCHEMA.optional(),
    })
    .strict(),
} as const satisfies Record<string, z.ZodType>;

export type StandardOutputSchemaName = keyof typeof STANDARD_OUTPUT_SCHEMAS;

export const standardOutputSchemaNames = Object.freeze(
  Object.keys(STANDARD_OUTPUT_SCHEMAS).sort()
) as readonly StandardOutputSchemaName[];

export function standardOutputSchemaJson(
  name: StandardOutputSchemaName
): string {
  const schema = STANDARD_OUTPUT_SCHEMAS[name];
  if (!schema) {
    throw new Error(`Missing standard output schema registry entry '${name}'`);
  }
  return JSON.stringify(
    z.toJSONSchema(schema, { target: "draft-07" }),
    null,
    2
  );
}

export function standardOutputSchemaPath(
  name: StandardOutputSchemaName
): string {
  return `.pipeline/schemas/${name}.schema.json`;
}

export function standardOutputSchemaNameFromPath(
  schemaPath: string
): StandardOutputSchemaName | null {
  const normalized = schemaPath.replaceAll("\\", "/");
  for (const name of standardOutputSchemaNames) {
    if (normalized === standardOutputSchemaPath(name)) {
      return name;
    }
  }
  return null;
}
