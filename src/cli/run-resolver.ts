// fallow-ignore-file complexity
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

  if (flags.command && target !== "remote") {
    throw new Error("--command requires --target remote");
  }
  if (flags.detach && target !== "local") {
    throw new Error("--detach requires --target local");
  }

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

function resolveLocalRuntime(
  flags: RunResolverFlags,
  effort: MokaRunEffort
): LocalRuntimeExecution {
  if (flags.schedule) {
    return { kind: "local-runtime", schedule: flags.schedule };
  }
  if (flags.workflow) {
    return { kind: "local-runtime", workflow: flags.workflow };
  }
  if (flags.readOnly) {
    return { kind: "local-runtime", workflow: "inspect" };
  }
  if (flags.entrypoint) {
    return { entrypoint: flags.entrypoint, kind: "local-runtime" };
  }
  if (effort === "quick") {
    return { entrypoint: "quick", kind: "local-runtime" };
  }
  if (effort === "thorough") {
    return { entrypoint: "execute", kind: "local-runtime" };
  }
  return { kind: "local-runtime" };
}
