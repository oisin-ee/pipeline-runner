import { defineConfig } from "tsdown";

export default defineConfig({
  clean: true,
  // Native TS7 (typescript@rc) drops the legacy JS API rolldown-plugin-dts
  // needs; generate declarations via the native tsgo binary instead.
  dts: { tsgo: true },
  entry: {
    "argo-submit": "src/argo-submit.ts",
    "argo-workflow": "src/argo-workflow.ts",
    config: "src/config.ts",
    "factory-lane": "src/factory/factory-lane.ts",
    hooks: "src/hooks.ts",
    index: "src/index.ts",
    "moka-global-config": "src/moka-global-config.ts",
    "moka-submit": "src/moka-submit.ts",
    "pipeline-runtime": "src/pipeline-runtime.ts",
    "planning/compile": "src/planning/compile.ts",
    "planning/generate": "src/planning/generate.ts",
    runner: "src/runner.ts",
    "runner-command-contract": "src/runner-command-contract.ts",
    "runner-event-schema": "src/runner-event-schema.ts",
    "tickets/ticket-graph-dto": "src/tickets/ticket-graph-dto.ts",
  },
  fixedExtension: false,
  format: "esm",
  hash: false,
  outExtensions: () => ({ dts: ".d.ts", js: ".js" }),
  platform: "node",
  target: "node22",
  unbundle: true,
});
