import { Mastra } from "@mastra/core/mastra";
import { pipelineWorkflow } from "./workflows/pipeline.js";

export const mastra = new Mastra({
  workflows: { pipelineWorkflow },
});
