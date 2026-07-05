import { z } from "zod";

export const hookArtifactSchema = z
  .object({
    contentType: z.string().optional(),
    name: z.string().min(1),
    path: z.string().min(1),
  })
  .strict();

export const hookResultSchema = z
  .object({
    artifacts: z.array(hookArtifactSchema).optional(),
    outputs: z.record(z.string(), z.unknown()).optional(),
    patch: z
      .object({
        runLabels: z.record(z.string(), z.string()).optional(),
        taskContext: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .optional(),
    status: z.enum(["pass", "fail", "skip"]),
    summary: z.string().optional(),
  })
  .strict();

export type HookResult = z.infer<typeof hookResultSchema>;

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
  hookResultSchema.parse(value);
