import { defineConfig } from "oxfmt";

import { toolIgnorePatterns } from "./tool-ignore-patterns.ts";

export default defineConfig({
  arrowParens: "always",
  bracketSameLine: false,
  bracketSpacing: true,
  endOfLine: "lf",
  ignorePatterns: [...toolIgnorePatterns],
  jsxSingleQuote: false,
  printWidth: 120,
  quoteProps: "as-needed",
  semi: true,
  singleQuote: false,
  sortImports: {
    ignoreCase: true,
    newlinesBetween: true,
    order: "asc",
  },
  sortPackageJson: true,
  tabWidth: 2,
  trailingComma: "all",
  useTabs: false,
});
