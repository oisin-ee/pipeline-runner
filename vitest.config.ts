import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    exclude: [".agents/**", ".mastra/**", "node_modules/**"],
    // Package contract tests rebuild shared dist artifacts and must not race
    // another test file that resolves the package through node_modules.
    fileParallelism: false,
    globals: true,
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
});
