import type { GateEvaluator, GateKind, GateKindModule } from "./contract";
import { acceptanceModule } from "./kinds/acceptance";
import { artifactModule } from "./kinds/artifact";
import { builtinModule } from "./kinds/builtin";
import { changedFilesModule } from "./kinds/changed-files";
import { commandModule } from "./kinds/command";
import { jsonSchemaModule } from "./kinds/json-schema";
import { verdictModule } from "./kinds/verdict";

/**
 * Exhaustive map from each {@link GateKind} to its {@link GateKindModule}.
 * Typed as `Record<GateKind, GateKindModule>` so the compiler rejects this
 * literal if any kind is missing. Adding a new gate kind to the config schema
 * surfaces a missing-key compile error here — no runtime gap possible.
 * New kinds: add a `kinds/<kind>/` module and one entry below.
 */
const allModules: Record<GateKind, GateKindModule> = {
  acceptance: acceptanceModule,
  artifact: artifactModule,
  builtin: builtinModule,
  changed_files: changedFilesModule,
  command: commandModule,
  json_schema: jsonSchemaModule,
  verdict: verdictModule,
};

/**
 * The gate dispatch table — one entry per {@link GateKind}. Derived from
 * {@link allModules} so each evaluator is owned by its module; this file is
 * pure wiring with no logic of its own.
 */
export const gateRegistry: Record<GateKind, GateEvaluator> = {
  acceptance: allModules.acceptance.evaluate,
  artifact: allModules.artifact.evaluate,
  builtin: allModules.builtin.evaluate,
  changed_files: allModules.changed_files.evaluate,
  command: allModules.command.evaluate,
  json_schema: allModules.json_schema.evaluate,
  verdict: allModules.verdict.evaluate,
};

/**
 * Resolves a gate to its registered evaluator and runs it. Single table lookup
 * replaces the former kind-discriminated branch ladder.
 */
export const evaluateGate = (
  input: Parameters<GateEvaluator>[0]
): ReturnType<GateEvaluator> => gateRegistry[input.gate.kind](input);
