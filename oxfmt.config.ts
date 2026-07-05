import ultracite from "ultracite/oxfmt";

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

export default {
  ...ultracite,
  ignorePatterns: [...(ultracite.ignorePatterns ?? []), ...repoIgnorePatterns],
};
