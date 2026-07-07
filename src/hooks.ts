import * as Schema from "effect/Schema";

import {
  parseWithSchema,
  requiredString,
  stringRecord,
  unknownRecord,
  struct,
} from "./schema-boundary";

const hookArtifact = struct({
  contentType: Schema.optional(Schema.String),
  name: requiredString,
  path: requiredString,
});

const hookResult = struct({
  artifacts: Schema.optional(Schema.mutable(Schema.Array(hookArtifact))),
  outputs: Schema.optional(unknownRecord),
  patch: Schema.optional(
    struct({
      runLabels: Schema.optional(stringRecord),
      taskContext: Schema.optional(unknownRecord),
    })
  ),
  status: Schema.Literals(["pass", "fail", "skip"]),
  summary: Schema.optional(Schema.String),
});

export { hookArtifact as hookArtifactSchema, hookResult as hookResultSchema };

export type HookResult = typeof hookResult.Type;

export interface HookContext {
  event: {
    gateId?: string;
    hookId: string;
    nodeId?: string;
    type: string;
    workflowId: string;
  };
  failure?: {
    evidence: string[];
    gate: string;
    nodeId?: string;
    reason: string;
  };
  input: Record<string, unknown>;
  node?: {
    id: string;
  };
  results: Record<string, HookResult>;
  task: string;
  taskContext?: {
    acceptanceCriteria?: { id: string; text: string }[];
    description?: string;
    id?: string;
    title?: string;
  };
  workflow: {
    id: string;
  };
}

export type HookFunction = (
  context: HookContext
) => HookResult | Promise<HookResult>;

export const defineHook = <T extends HookFunction>(hook: T): T => hook;

export const parseHookResult = (value: unknown): HookResult =>
  parseWithSchema(hookResult, value, { onExcessProperty: "error" });
