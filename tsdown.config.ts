import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    config: "src/config.ts",
    hooks: "src/hooks.ts",
    index: "src/index.ts",
    "pipeline-runtime": "src/pipeline-runtime.ts",
    runner: "src/runner.ts",
    "runner-job-contract": "src/runner-job-contract.ts",
    "runner-job-k8s": "src/runner-job/k8s.ts",
    "runtime/goal-loop": "src/runtime/goal-loop/goal-loop.ts",
    "runtime/goal-state": "src/runtime/goal-state/goal-state.ts",
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
