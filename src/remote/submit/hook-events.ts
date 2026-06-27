import type { HookEvent } from "../../config";

export const MOKA_SUBMIT_HOOK_EVENTS: readonly [HookEvent, ...HookEvent[]] = [
  "workflow.start",
  "workflow.success",
  "workflow.failure",
  "workflow.complete",
  "node.start",
  "node.success",
  "node.error",
  "node.finish",
  "gate.failure",
];
