export const MOKA_RUN_EFFORTS = ["normal", "quick", "thorough"] as const;
export const MOKA_RUN_TARGETS = ["local", "remote"] as const;

export type MokaRunEffort = (typeof MOKA_RUN_EFFORTS)[number];
export type MokaRunTarget = (typeof MOKA_RUN_TARGETS)[number];
export type MokaRunMode = "read" | "write";

export interface RunResolverFlags {
  command?: boolean;
  detach?: boolean;
  effort?: MokaRunEffort;
  entrypoint?: string;
  readOnly?: boolean;
  schedule?: string;
  target?: MokaRunTarget;
  workflow?: string;
}

export interface LocalRuntimeExecution {
  entrypoint?: string;
  kind: "local-runtime";
  schedule?: string;
  workflow?: string;
}

export interface RemoteSubmitExecution {
  command?: boolean;
  kind: "remote-submit";
  mode: "full" | "quick";
  schedule?: string;
}

export interface RunResolution {
  effort: MokaRunEffort;
  execution: LocalRuntimeExecution | RemoteSubmitExecution;
  mode: MokaRunMode;
  target: MokaRunTarget;
}

export function resolveMokaRun(input: {
  flags?: RunResolverFlags;
  task: string;
}): RunResolution {
  const flags = input.flags ?? {};
  const effort = flags.effort ?? "normal";
  const target = flags.target ?? "local";
  const mode = flags.readOnly ? "read" : "write";

  assertFlagTargetCompatibility(flags, target);

  return {
    effort,
    execution:
      target === "remote"
        ? resolveRemoteSubmit(flags, effort)
        : resolveLocalRuntime(flags, effort),
    mode,
    target,
  };
}

function assertFlagTargetCompatibility(
  flags: RunResolverFlags,
  target: MokaRunTarget
): void {
  if (flags.command && target !== "remote") {
    throw new Error("--command requires --target remote");
  }
  if (flags.detach && target !== "local") {
    throw new Error("--detach requires --target local");
  }
}

function resolveRemoteSubmit(
  flags: RunResolverFlags,
  effort: MokaRunEffort
): RemoteSubmitExecution {
  return {
    command: flags.command,
    kind: "remote-submit",
    mode: effort === "quick" ? "quick" : "full",
    schedule: flags.schedule,
  };
}

// Precedence-ordered resolvers: the first that applies wins. Expressing the
// selection as a table keeps each branch trivial (and the whole resolver under
// the complexity gate) instead of a long if/else chain.
type LocalRuntimeResolver = (
  flags: RunResolverFlags,
  effort: MokaRunEffort
) => LocalRuntimeExecution | undefined;

const LOCAL_RUNTIME_RESOLVERS: LocalRuntimeResolver[] = [
  (flags) =>
    flags.schedule
      ? { kind: "local-runtime", schedule: flags.schedule }
      : undefined,
  (flags) =>
    flags.workflow
      ? { kind: "local-runtime", workflow: flags.workflow }
      : undefined,
  (flags) =>
    flags.readOnly ? { kind: "local-runtime", workflow: "inspect" } : undefined,
  (flags) =>
    flags.entrypoint
      ? { entrypoint: flags.entrypoint, kind: "local-runtime" }
      : undefined,
  (_flags, effort) =>
    effort === "quick"
      ? { entrypoint: "quick", kind: "local-runtime" }
      : undefined,
  (_flags, effort) =>
    effort === "thorough"
      ? { entrypoint: "execute", kind: "local-runtime" }
      : undefined,
];

function resolveLocalRuntime(
  flags: RunResolverFlags,
  effort: MokaRunEffort
): LocalRuntimeExecution {
  for (const resolve of LOCAL_RUNTIME_RESOLVERS) {
    const resolved = resolve(flags, effort);
    if (resolved) {
      return resolved;
    }
  }
  return { kind: "local-runtime" };
}
