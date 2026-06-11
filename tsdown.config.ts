import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    "argo-workflow": "src/argo-workflow.ts",
    "argo-submit": "src/argo-submit.ts",
    config: "src/config.ts",
    hooks: "src/hooks.ts",
    index: "src/index.ts",
    "moka-global-config": "src/moka-global-config.ts",
    "moka-submit": "src/moka-submit.ts",
    "pipeline-runtime": "src/pipeline-runtime.ts",
    runner: "src/runner.ts",
    "runner-command-contract": "src/runner-command-contract.ts",
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
