import { strict } from "@oisin-ee/oxlint-config";
import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

// Biome -> oxc migration: replaces biome.jsonc for linting. This repo uses Effect
// (effect@4.0.0-beta.90) — add the `effect`/`effectMigration` presets from
// @oisin-ee/oxlint-config scoped to the Effect code, plus any framework preset.
// See the migration Backlog ticket.
export default defineConfig({
  extends: [core, strict],
  options: {
    typeAware: true,
    typeCheck: true,
  },
});
