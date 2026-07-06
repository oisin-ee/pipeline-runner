import * as Schema from "effect/Schema";

import { requiredString, struct } from "./schema-boundary";

export const workflowSubmitResultSchema = struct({
  namespace: requiredString,
  payloadConfigMapName: requiredString,
  scheduleConfigMapName: Schema.optional(requiredString),
  taskDescriptorConfigMapName: Schema.optional(requiredString),
  workflowName: requiredString,
  workflowUid: Schema.optional(requiredString),
});
