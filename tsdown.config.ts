import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    config: "src/config.ts",
    index: "src/index.ts",
    "pipeline-runtime": "src/pipeline-runtime.ts",
    runner: "src/runner.ts",
    "schedule-planner": "src/schedule-planner.ts",
    "workflow-planner": "src/workflow-planner.ts",
  },
  fixedExtension: false,
  format: "esm",
  hash: false,
  outExtensions: () => ({ dts: ".d.ts", js: ".js" }),
  platform: "node",
  target: "node22",
  unbundle: true,
});
