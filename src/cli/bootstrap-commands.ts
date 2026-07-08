import { resolve } from "node:path";

import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import {
  formatCodexAuthSyncResult,
  syncLocalCodexAuth,
} from "../credentials/local-codex-auth-sync";
import { formatJsonDocument } from "../install-commands/opencode";
import {
  formatPipelineInitResult,
  initPipelineProject,
} from "../pipeline-init";
import { runDoctor as runDoctorChecks } from "./doctor";
import type { DoctorFlags } from "./doctor";
import { formatDoctorResult, writeTerminalLog } from "./format";

interface InitFlags {
  check?: boolean;
  dryRun?: boolean;
  force?: boolean;
}

interface CodexAuthSyncLocalFlags {
  check?: boolean;
  dryRun?: boolean;
  root?: string;
}

const doctorFlags = {
  cluster: Flag.string("cluster").pipe(
    Flag.withDescription("also check runner-job Kubernetes prerequisites"),
    Flag.withDefault(false),
    Flag.map((value) => (value === "true" ? true : value))
  ),
  json: Flag.boolean("json").pipe(
    Flag.withDescription("print machine-readable readiness results")
  ),
  kubeContext: Flag.string("kube-context").pipe(
    Flag.withDescription("kubectl context for cluster checks"),
    Flag.optional
  ),
  kubeconfig: Flag.string("kubeconfig").pipe(
    Flag.withDescription("kubeconfig path for cluster checks"),
    Flag.optional
  ),
};

const initFlags = {
  check: Flag.boolean("check").pipe(
    Flag.withDescription(
      "verify the installed adapters are current; fail if stale"
    )
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("show planned changes without writing files")
  ),
  force: Flag.boolean("force").pipe(
    Flag.withDescription("overwrite manually edited command adapter files")
  ),
};

const codexAuthSyncLocalFlags = {
  check: Flag.boolean("check").pipe(
    Flag.withDescription("fail if local Codex auth config is not synced")
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("show planned changes without writing files")
  ),
  root: Flag.string("root").pipe(
    Flag.withDescription("directory containing repositories to sync"),
    Flag.optional
  ),
};

const normalizeDoctorFlags = (
  flags: Command.Command.Config.Infer<typeof doctorFlags>
): DoctorFlags => ({
  cluster: flags.cluster === false ? undefined : flags.cluster,
  json: flags.json,
  kubeContext: Option.getOrUndefined(flags.kubeContext),
  kubeconfig: Option.getOrUndefined(flags.kubeconfig),
});

const normalizeInitFlags = (
  flags: Command.Command.Config.Infer<typeof initFlags>
): InitFlags => ({
  check: flags.check,
  dryRun: flags.dryRun,
  force: flags.force,
});

const normalizeCodexAuthSyncLocalFlags = (
  flags: Command.Command.Config.Infer<typeof codexAuthSyncLocalFlags>
): CodexAuthSyncLocalFlags => ({
  check: flags.check,
  dryRun: flags.dryRun,
  root: Option.getOrUndefined(flags.root),
});

const writeOutput = writeTerminalLog;

const formatDoctorCommandResult = (
  result: Awaited<ReturnType<typeof runDoctorChecks>>,
  flags: DoctorFlags
): string =>
  flags.json === true ? formatJsonDocument(result) : formatDoctorResult(result);

const doctorCommand = Command.make("doctor", doctorFlags, (rawFlags) =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => {
      const flags = normalizeDoctorFlags(rawFlags);
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      const result = await runDoctorChecks(cwd, flags);
      writeOutput(formatDoctorCommandResult(result, flags));

      if (!result.passed) {
        throw new Error("Doctor checks failed.");
      }
    },
  })
).pipe(
  Command.withDescription(
    "Check local prerequisites for pipeline init and execution"
  )
);

const initCommand = Command.make("init", initFlags, (rawFlags) =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => {
      const flags = normalizeInitFlags(rawFlags);
      const result = await initPipelineProject({
        ...flags,
        cwd: process.env.PIPELINE_TARGET_PATH ?? process.cwd(),
      });
      writeOutput(formatPipelineInitResult(result, flags));
    },
  })
).pipe(
  Command.withDescription(
    [
      "Install or refresh Moka host adapters (/moka-execute, /moka-inspect, /moka-quick command surfaces,",
      "native-agent projections, and gateway config), globally to ~/.claude, ~/.config/opencode, ~/.codex",
      "with no repo-local config. The shared agent harness (skills, hooks, instruction rules) is provisioned",
      "separately from oisin-ee/agent via chezmoi, not by Moka.",
    ].join(" ")
  )
);

const codexAuthSyncLocalCommand = Command.make(
  "sync-local",
  codexAuthSyncLocalFlags,
  (rawFlags) =>
    Effect.try({
      catch: (error) => error,
      try: () => {
        const flags = normalizeCodexAuthSyncLocalFlags(rawFlags);
        const result = syncLocalCodexAuth({
          check: flags.check,
          dryRun: flags.dryRun,
          root: resolve(
            flags.root ?? process.env.PIPELINE_TARGET_PATH ?? process.cwd()
          ),
        });
        writeOutput(formatCodexAuthSyncResult(result));

        if (!result.ok) {
          process.exitCode = 1;
        }
      },
    })
).pipe(
  Command.withDescription(
    "Point local dev repos' opencode openai provider at the central CLIProxyAPI broker"
  )
);

const codexAuthCommand = Command.make("codex-auth").pipe(
  Command.withDescription("Manage local Codex broker auth integration"),
  Command.withSubcommands([codexAuthSyncLocalCommand])
);

export const createBootstrapCommands = () => [
  doctorCommand,
  initCommand,
  codexAuthCommand,
];
