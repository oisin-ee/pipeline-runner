import { effect, strict } from "@oisin-ee/oxlint-config";
import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

const repoIgnorePatterns = [
  "backlog/archive/**",
  "backlog/completed/**",
  "backlog/.locks/**",
  ".pipeline/runs/**",
  ".pipeline/journal/**",
  ".pipeline/worktrees/**",
  ".pipeline/dogfood/**",
  ".worktrees/**",
  "report/**",
  ".opencode/node_modules/**",
  ".devspace/**",
  ".fallow/**",
  ".serena/**",
];

export default defineConfig({
  extends: [core, strict],
  ignorePatterns: [...(core.ignorePatterns ?? []), ...repoIgnorePatterns],
  options: {
    typeAware: true,
    typeCheck: true,
  },
  overrides: [{ files: ["src/**/*.ts", "tests/**/*.ts"], ...effect }],
});
