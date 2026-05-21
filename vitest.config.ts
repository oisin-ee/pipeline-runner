import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    exclude: [".agents/**", ".mastra/**", "node_modules/**"],
    globals: true,
    include: ["tests/**/*.test.ts"],
  },
});
