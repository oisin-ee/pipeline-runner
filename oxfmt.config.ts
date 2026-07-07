import ultracite from "ultracite/oxfmt";

import { toolIgnorePatterns } from "./tool-ignore-patterns.ts";

export default {
  ...ultracite,
  ignorePatterns: [...(ultracite.ignorePatterns ?? []), ...toolIgnorePatterns],
};
