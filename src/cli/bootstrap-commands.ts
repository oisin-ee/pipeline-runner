import { resolve } from "node:path";

import type { Command } from "commander";

import {
  formatCodexAuthSyncResult,
  syncLocalCodexAuth,
} from "../credentials/local-codex-auth-sync";
import {
  formatPipelineInitResult,
  initPipelineProject,
} from "../pipeline-init";
import { runDoctor as runDoctorChecks } from "./doctor";
import type { DoctorFlags } from "./doctor";
import { formatDoctorResult } from "./format";

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

export const registerBootstrapCommands = (program: Command): void => {
  program
    .command("doctor")
    .description("Check local prerequisites for pipeline init and execution")
    .option(
      "--cluster [namespace]",
      "also check runner-job Kubernetes prerequisites"
    )
    .option("--json", "print machine-readable readiness results")
    .option("--kube-context <context>", "kubectl context for cluster checks")
    .option("--kubeconfig <path>", "kubeconfig path for cluster checks")
    .action(async (flags: DoctorFlags) => {
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      const result = await runDoctorChecks(cwd, flags);
      console.log(
        flags.json === true
          ? JSON.stringify(result)
          : formatDoctorResult(result)
      );
      if (!result.passed) {
        throw new Error("Doctor checks failed.");
      }
    });

  program
    .command("init")
    .description(
      [
        "Install or refresh Moka host adapters (/moka-execute, /moka-inspect, /moka-quick command surfaces,",
        "native-agent projections, and gateway config), globally to ~/.claude, ~/.config/opencode, ~/.codex",
        "with no repo-local config. The shared agent harness (skills, hooks, instruction rules) is provisioned",
        "separately from oisin-ee/agent via chezmoi, not by Moka.",
      ].join(" ")
    )
    .option(
      "--check",
      "verify the installed adapters are current; fail if stale"
    )
    .option("--dry-run", "show planned changes without writing files")
    .option("--force", "overwrite manually edited command adapter files")
    .action(async (flags: InitFlags) => {
      const result = await initPipelineProject({
        ...flags,
        cwd: process.env.PIPELINE_TARGET_PATH ?? process.cwd(),
      });
      console.log(
        formatPipelineInitResult(result, {
          check: flags.check,
          dryRun: flags.dryRun,
        })
      );
    });

  const codexAuthCommand = program
    .command("codex-auth")
    .description("Manage local Codex broker auth integration");

  codexAuthCommand
    .command("sync-local")
    .description(
      "Point local dev repos' opencode openai provider at the central CLIProxyAPI broker"
    )
    .option("--root <path>", "directory containing repositories to sync")
    .option("--dry-run", "show planned changes without writing files")
    .option("--check", "fail if local Codex auth config is not synced")
    .action((flags: CodexAuthSyncLocalFlags) => {
      const result = syncLocalCodexAuth({
        check: flags.check,
        dryRun: flags.dryRun,
        root: resolve(
          flags.root ?? process.env.PIPELINE_TARGET_PATH ?? process.cwd()
        ),
      });
      console.log(formatCodexAuthSyncResult(result));
      if (!result.ok) {
        process.exitCode = 1;
      }
    });
};
