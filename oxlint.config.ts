import { effect, strict } from "@oisin-ee/oxlint-config";
import { defineConfig } from "oxlint";
import type { DummyRuleMap } from "oxlint";
import core from "ultracite/oxlint/core";

import { toolIgnorePatterns } from "./tool-ignore-patterns.ts";

const promotedEffectRules: DummyRuleMap = {
  "effect/avoid-direct-json": "error",
  "effect/avoid-direct-tag-checks": "error",
  "effect/avoid-mutable-state": "error",
  "effect/avoid-native-object-helpers": "error",
  "effect/avoid-platform-coupling": "error",
  "effect/avoid-schema-suffix": "error",
  "effect/context-tag-extends": "error",
  "effect/imperative-loops": "error",
  "effect/maybe-prefix-requires-option": "error",
  "effect/no-barrel-imports": "error",
  "effect/no-length-comparison": "error",
  "effect/no-opaque-instance-fields": "error",
  "effect/prefer-arr-match": "error",
  "effect/prefer-arr-sort": "error",
  "effect/prefer-array-fromoption-over-option-match-empty": "error",
  "effect/prefer-effect-fn": "error",
  "effect/prefer-effect-is": "error",
  "effect/prefer-match-over-switch": "error",
  "effect/prefer-namespace-imports": "error",
  "effect/require-filter-metadata": "error",
  "effect/require-is-prefix-for-boolean-schema-field": "error",
  "effect/require-schema-type-alias": "error",
};

const effectWithErrors = {
  ...effect,
  rules: {
    ...effect.rules,
    ...promotedEffectRules,
  },
};

export default defineConfig({
  extends: [core, strict],
  ignorePatterns: [...(core.ignorePatterns ?? []), ...toolIgnorePatterns],
  options: {
    denyWarnings: true,
    typeAware: true,
    typeCheck: true,
  },
  overrides: [{ files: ["src/**/*.ts", "tests/**/*.ts"], ...effectWithErrors }],
  plugins: ["typescript", "import"],
  rules: {
    "import/no-namespace": ["error", { ignore: ["effect/*"] }],
  },
});
