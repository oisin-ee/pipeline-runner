import * as Option from "effect/Option";

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
  command: boolean;
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

const assertFlagTargetCompatibility = (
  flags: RunResolverFlags,
  target: MokaRunTarget
): void => {
  if (flags.command === true && target !== "remote") {
    throw new Error("--command requires --target remote");
  }
  if (flags.detach === true && target !== "local") {
    throw new Error("--detach requires --target local");
  }
};

const resolveRemoteSubmit = (
  flags: RunResolverFlags,
  effort: MokaRunEffort
): RemoteSubmitExecution => ({
  command: flags.command === true,
  kind: "remote-submit",
  mode: effort === "quick" ? "quick" : "full",
  schedule: flags.schedule,
});

// Precedence-ordered resolvers: the first that applies wins. Expressing the
// selection as a table keeps each branch trivial (and the whole resolver under
// the complexity gate) instead of a long if/else chain.
type LocalRuntimeResolver = (
  flags: RunResolverFlags,
  effort: MokaRunEffort
) => Option.Option<LocalRuntimeExecution>;

const LOCAL_RUNTIME_RESOLVERS: LocalRuntimeResolver[] = [
  (flags) =>
    flags.schedule !== undefined && flags.schedule !== ""
      ? Option.some({ kind: "local-runtime", schedule: flags.schedule })
      : Option.none(),
  (flags) =>
    flags.workflow !== undefined && flags.workflow !== ""
      ? Option.some({ kind: "local-runtime", workflow: flags.workflow })
      : Option.none(),
  (flags) =>
    flags.readOnly === true
      ? Option.some({ kind: "local-runtime", workflow: "inspect" })
      : Option.none(),
  (flags) =>
    flags.entrypoint !== undefined && flags.entrypoint !== ""
      ? Option.some({ entrypoint: flags.entrypoint, kind: "local-runtime" })
      : Option.none(),
  (_flags, effort) =>
    effort === "quick"
      ? Option.some({ entrypoint: "quick", kind: "local-runtime" })
      : Option.none(),
  (_flags, effort) =>
    effort === "thorough"
      ? Option.some({ entrypoint: "execute", kind: "local-runtime" })
      : Option.none(),
];

const resolveLocalRuntime = (
  flags: RunResolverFlags,
  effort: MokaRunEffort
): LocalRuntimeExecution => {
  for (const resolve of LOCAL_RUNTIME_RESOLVERS) {
    const resolved = resolve(flags, effort);
    if (Option.isSome(resolved)) {
      return resolved.value;
    }
  }
  return { kind: "local-runtime" };
};

export const resolveMokaRun = (input: {
  flags?: RunResolverFlags;
  task: string;
}): RunResolution => {
  const flags = input.flags ?? {};
  const effort = flags.effort ?? "normal";
  const target = flags.target ?? "local";
  const mode = flags.readOnly === true ? "read" : "write";

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
};
