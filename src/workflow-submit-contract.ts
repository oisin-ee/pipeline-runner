import { z } from "zod";

export const workflowSubmitResultSchema = z
  .object({
    namespace: z.string().min(1),
    payloadConfigMapName: z.string().min(1),
    scheduleConfigMapName: z.string().min(1).optional(),
    taskDescriptorConfigMapName: z.string().min(1).optional(),
    workflowName: z.string().min(1),
    workflowUid: z.string().min(1).optional(),
  })
  .strict();
