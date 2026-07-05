import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const PUBLIC_RUNTIME_CONTRACTS = [
  "runtimeActorId",
  "RuntimeActorIdParts",
  "RuntimeActorKind",
  "RuntimeActorDescriptor",
  "RuntimeObservabilityEmitter",
  "RuntimeObservabilityEvent",
  "RetryReason",
  "NodeRetryPolicyContract",
] as const;

const EXPECTED_PACKAGE_EXPORTS = [
  ".",
  "./argo-submit",
  "./argo-workflow",
  "./config",
  "./factory-lane",
  "./events",
  "./hooks",
  "./moka-global-config",
  "./moka-submit",
  "./planner",
  "./runner",
  "./runner-command-contract",
  "./runtime",
  "./schedule",
  "./tickets",
] as const;

const RUNTIME_MACHINE_CONTRACT_IMPORT_RE =
  /import\s+(?:type\s+)?(?:\{(?<names>[\s\S]*?)\}|(?<defaultName>[A-Za-z_$][\w$]*))\s+from\s+["'][^"']*runtime-machines\/contracts["']/gu;
const XSTATE_IMPORT_RE = /from\s+["']xstate["']/u;
const RUNTIME_OBSERVABILITY_INSPECTION_IMPORT_RE =
  /from\s+["'][^"']*runtime-observability-inspection["']/u;
const RUNTIME_MACHINE_IMPORT_RE = /from\s+["'][^"']*runtime-machines\//u;
const GATE_OR_HOOK_MACHINE_IMPORT_RE =
  /from\s+["'][^"']*runtime-machines\/(?:gate-machine|hook-machine)["']/u;
const NODE_MACHINE_IMPORT_RE =
  /from\s+["'][^"']*runtime-machines\/node-machine["']/u;
const NODE_MACHINE_ACTOR_ROUND_TRIP_RE =
  /RETRYING[\s\S]{0,800}(?:getSnapshot\(\)|nodeStates\.get)[\s\S]{0,200}\.retry|(?:getSnapshot\(\)|nodeStates\.get)[\s\S]{0,200}\.retry[\s\S]{0,800}RETRYING/u;
const LOCKFILE_XSTATE_RE = /\bxstate\b/u;
const NODE_EXECUTION_EVENT_EXPORT_RE = /export\s+type\s+NodeExecutionEvent\b/u;
const NODE_STATE_STORE_FIELD_RE = /nodeStateStore\s*:\s*NodeStateStore\b/u;
const LEGACY_RUNTIME_CONTEXT_NODE_STATE_FIELDS_RE =
  /\b(?:inheritedOutputNodeIds|lastOutputByNode|nodeSnapshots|nodeStates|structuredOutputs)\s*:/u;
const RUNTIME_CONTEXT_INTERFACE_RE =
  /export interface RuntimeContext \{[\s\S]*?\n\}/u;
const RUNTIME_MACHINES_CONTRACTS_TEXT_RE = /runtime-machines\/contracts/u;
const RUNTIME_ACTOR_DESCRIPTOR_EXPORT_RE =
  /export\s+(?:type|interface)\s+RuntimeActorDescriptor\b/u;
const RUNTIME_MACHINES_PATH_SEGMENT = "runtime-machines";
const PATH_SEPARATOR_RE = /[\\/]/u;
const TYPE_KEYWORD_RE = /\btype\b/gu;
const IMPORT_ALIAS_RE = /\s+as\s+/u;
const IGNORED_SCAN_DIRS = new Set([
  ".git",
  ".fallow",
  "coverage",
  "dist",
  "node_modules",
]);

const sourceFiles = (dir: string): string[] => {
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(dir, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(absolute);
    }

    return [".ts", ".tsx"].includes(extname(entry.name)) ? [absolute] : [];
  });
};

const repositoryFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (IGNORED_SCAN_DIRS.has(entry.name)) {
      return [];
    }

    const absolute = join(dir, entry.name);

    if (entry.isDirectory()) {
      return repositoryFiles(absolute);
    }

    return [".ts", ".tsx", ".mts", ".cts"].includes(extname(entry.name))
      ? [absolute]
      : [];
  });

const importsFromRuntimeMachineContracts = (source: string): string[] => {
  const imports = source.matchAll(RUNTIME_MACHINE_CONTRACT_IMPORT_RE);

  return [...imports]
    .flatMap((match) => {
      const names = match.groups?.names;
      const defaultName = match.groups?.defaultName;

      if (names) {
        return names
          .split(",")
          .map(
            (name) =>
              name.replace(TYPE_KEYWORD_RE, "").trim().split(IMPORT_ALIAS_RE)[0]
          )
          .filter(Boolean);
      }

      return defaultName ? [defaultName] : [];
    })
    .filter((name) =>
      PUBLIC_RUNTIME_CONTRACTS.includes(
        name as (typeof PUBLIC_RUNTIME_CONTRACTS)[number]
      )
    );
};

describe("runtime actor/retry contract module boundary", () => {
  it("removes the runtime-machines TypeScript surface and all runtime-machines imports", () => {
    const runtimeMachineFiles = sourceFiles(
      join(process.cwd(), "src", "runtime-machines")
    ).map((file) => relative(process.cwd(), file));
    const runtimeMachineNamedFiles = repositoryFiles(process.cwd())
      .map((file) => relative(process.cwd(), file))
      .filter((file) =>
        file
          .split(PATH_SEPARATOR_RE)
          .some((part) => part.includes(RUNTIME_MACHINES_PATH_SEGMENT))
      );
    const offenders = repositoryFiles(process.cwd()).flatMap((file) => {
      const source = readFileSync(file, "utf-8");

      return RUNTIME_MACHINE_IMPORT_RE.test(source)
        ? [{ file: relative(process.cwd(), file) }]
        : [];
    });

    expect(runtimeMachineFiles).toEqual([]);
    expect(runtimeMachineNamedFiles).toEqual([]);
    expect(offenders).toEqual([]);
  });

  it("removes legacy inspection-bridge imports and direct xstate imports from runtime and tests", () => {
    const offenders = repositoryFiles(process.cwd()).flatMap((file) => {
      const source = readFileSync(file, "utf-8");
      const violations = [
        RUNTIME_OBSERVABILITY_INSPECTION_IMPORT_RE.test(source)
          ? "runtime-observability-inspection"
          : undefined,
        XSTATE_IMPORT_RE.test(source) ? "xstate" : undefined,
      ].filter(Boolean);

      return violations.length
        ? [{ file: relative(process.cwd(), file), violations }]
        : [];
    });

    expect(
      existsSync(join(process.cwd(), "src/runtime-observability-inspection.ts"))
    ).toBe(false);
    expect(offenders).toEqual([]);
  });

  it("keeps xstate out of package metadata and lockfile", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf-8")
    ) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
      peerDependencies?: Record<string, unknown>;
      optionalDependencies?: Record<string, unknown>;
    };
    const dependencySections = [
      packageJson.dependencies,
      packageJson.devDependencies,
      packageJson.peerDependencies,
      packageJson.optionalDependencies,
    ].filter(Boolean);
    const lockfile = readFileSync(join(process.cwd(), "lock.yaml"), "utf-8");

    expect(
      dependencySections.flatMap((section) => Object.keys(section ?? {}))
    ).not.toContain("xstate");
    expect(lockfile).not.toMatch(LOCKFILE_XSTATE_RE);
  });

  it("inlines gate and hook runtime evaluation without xstate machine dependencies", () => {
    const runtimeModules = [
      "src/runtime/gates/gates.ts",
      "src/runtime/hooks/hooks.ts",
    ];

    const offenders = runtimeModules.flatMap((file) => {
      const source = readFileSync(join(process.cwd(), file), "utf-8");
      const forbiddenImports = [
        XSTATE_IMPORT_RE,
        GATE_OR_HOOK_MACHINE_IMPORT_RE,
      ].filter((pattern) => pattern.test(source));

      return forbiddenImports.length ? [{ file, forbiddenImports }] : [];
    });

    expect(offenders).toEqual([]);
    expect(
      [
        "src/runtime-machines/gate-machine.ts",
        "src/runtime-machines/hook-machine.ts",
      ].filter((file) => existsSync(join(process.cwd(), file)))
    ).toEqual([]);
  });

  it("uses a plain node state tracker instead of the deleted node xstate machine", () => {
    const nodeMachinePath = join(
      process.cwd(),
      "src/runtime-machines/node-machine.ts"
    );
    const offenders = sourceFiles(join(process.cwd(), "src")).flatMap(
      (file) => {
        const source = readFileSync(file, "utf-8");

        return NODE_MACHINE_IMPORT_RE.test(source)
          ? [{ file: relative(process.cwd(), file) }]
          : [];
      }
    );

    expect(existsSync(nodeMachinePath)).toBe(false);
    expect(offenders).toEqual([]);
  });

  it("does not make retry observability depend on a RETRYING getSnapshot round trip", () => {
    const pipelineRuntime = readFileSync(
      join(process.cwd(), "src/pipeline-runtime.ts"),
      "utf-8"
    );

    expect(pipelineRuntime).not.toMatch(NODE_MACHINE_ACTOR_ROUND_TRIP_RE);
  });

  it("keeps source files off runtime-machines/contracts for public actor, node event, and retry contracts", () => {
    const offenders = sourceFiles(join(process.cwd(), "src"))
      .map((file) => ({ file, relativeFile: relative(process.cwd(), file) }))
      .flatMap(({ file, relativeFile }) => {
        const importedContracts = importsFromRuntimeMachineContracts(
          readFileSync(file, "utf-8")
        );

        return importedContracts.length
          ? [{ file: relativeFile, importedContracts }]
          : [];
      });

    expect(offenders).toEqual([]);
    const trackerSource = readFileSync(
      join(process.cwd(), "src/runtime/node-state-tracker.ts"),
      "utf-8"
    );
    expect(trackerSource).toMatch(NODE_EXECUTION_EVENT_EXPORT_RE);
    expect(trackerSource).not.toMatch(RUNTIME_MACHINES_CONTRACTS_TEXT_RE);
    expect(
      readFileSync(join(process.cwd(), "src/runtime/actor-ids.ts"), "utf-8")
    ).toMatch(RUNTIME_ACTOR_DESCRIPTOR_EXPORT_RE);
  });

  it("does not add or remove package export paths while introducing the internal actor id module", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf-8")
    ) as { exports: Record<string, unknown> };

    expect(Object.keys(packageJson.exports).toSorted()).toEqual(
      [...EXPECTED_PACKAGE_EXPORTS].toSorted()
    );
  });

  it("does not build retired goal runtime entrypoints as standalone package surfaces", () => {
    const tsdownConfig = readFileSync(
      join(process.cwd(), "tsdown.config.ts"),
      "utf-8"
    );

    expect(tsdownConfig).not.toContain('"runtime/goal-loop"');
    expect(tsdownConfig).not.toContain('"runtime/goal-state"');
  });

  it("exposes runtime node execution state through the internal NodeStateStore field only", () => {
    const contractsSource = readFileSync(
      join(process.cwd(), "src/runtime/contracts/contracts.ts"),
      "utf-8"
    );
    const runtimeContextSource =
      RUNTIME_CONTEXT_INTERFACE_RE.exec(contractsSource)?.[0];

    expect(runtimeContextSource).toBeDefined();
    expect(runtimeContextSource).toMatch(NODE_STATE_STORE_FIELD_RE);
    expect(runtimeContextSource).not.toMatch(
      LEGACY_RUNTIME_CONTEXT_NODE_STATE_FIELDS_RE
    );
  });
});
