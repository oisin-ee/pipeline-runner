import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type {
  integer,
  nonNegativeInteger,
  positiveInteger,
  positiveNumber,
  stringArray,
  stringRecord,
  trimmedRequiredString,
  unknownRecord,
  urlString,
} from "../src/schema-boundary";
import {
  decodeWithSchema,
  effectSchemaDocumentDraft07,
  parseResultWithSchema,
  parseWithSchema,
  requiredString,
  withDefault,
  struct,
} from "../src/schema-boundary";

const boundary = struct({
  id: Schema.NonEmptyString,
});

const nestedBoundary = struct({
  metadata: struct({
    label: Schema.NonEmptyString,
  }),
});

describe("Effect Schema boundary helpers", () => {
  it("exports type aliases for exported schema constants", () => {
    expectTypeOf<requiredString>().toExtend<string>();
    expectTypeOf<trimmedRequiredString>().toExtend<string>();
    expectTypeOf<stringArray>().toExtend<readonly string[]>();
    expectTypeOf<unknownRecord>().toExtend<Record<string, unknown>>();
    expectTypeOf<stringRecord>().toExtend<Record<string, string>>();
    expectTypeOf<integer>().toExtend<number>();
    expectTypeOf<positiveInteger>().toExtend<number>();
    expectTypeOf<nonNegativeInteger>().toExtend<number>();
    expectTypeOf<positiveNumber>().toExtend<number>();
    expectTypeOf<urlString>().toExtend<string>();
  });

  it("strips excess properties by default", () => {
    expect(
      parseWithSchema(boundary, { extra: "drop-me", id: "ticket-1" })
    ).toEqual({ id: "ticket-1" });
  });

  it("fails on excess properties when ParseOptions request strict behaviour", () => {
    expect(() =>
      parseWithSchema(
        boundary,
        { extra: "reject-me", id: "ticket-1" },
        { onExcessProperty: "error" }
      )
    ).toThrow();
  });

  it("preserves excess properties when ParseOptions request passthrough behaviour", () => {
    expect(
      parseWithSchema(
        boundary,
        { extra: "keep-me", id: "ticket-1" },
        { onExcessProperty: "preserve" }
      )
    ).toEqual({
      extra: "keep-me",
      id: "ticket-1",
    });
  });

  it("returns Effect schema issue paths from parse result failures", () => {
    const result = parseResultWithSchema(
      nestedBoundary,
      { metadata: { label: "", unexpected: true } },
      { errors: "all", onExcessProperty: "error" }
    );

    expect(result.ok).toBe(false);
    const issues = result.ok ? [] : result.issues;
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["metadata", "label"] }),
        expect.objectContaining({ path: ["metadata", "unexpected"] }),
      ])
    );
  });

  it("applies decoding defaults when the encoded key is absent or undefined", () => {
    const schema = struct({
      id: withDefault(requiredString, "generated-id"),
    });

    expect(parseWithSchema(schema, {})).toEqual({ id: "generated-id" });
    expect(parseWithSchema(schema, { id: undefined })).toEqual({
      id: "generated-id",
    });
  });

  it.effect("supports Effect decode effects at the same public seam", () =>
    Effect.gen(function* decodeBoundary() {
      const decoded = yield* decodeWithSchema(boundary, {
        extra: "drop-me",
        id: "ticket-1",
      });
      expect(decoded).toEqual({ id: "ticket-1" });
    })
  );

  it("emits draft-07 JSON Schema through Effect's document converter", () => {
    const schema = effectSchemaDocumentDraft07(boundary);

    expect(schema).toMatchObject({
      $schema: "http://json-schema.org/draft-07/schema",
      additionalProperties: false,
      properties: { id: { type: "string" } },
      required: ["id"],
      type: "object",
    });
  });
});
