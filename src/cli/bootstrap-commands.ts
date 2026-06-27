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
import { type DoctorFlags, runDoctor as runDoctorChecks } from "./doctor";
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

export function registerBootstrapCommands(program: Command): void {
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
        flags.json ? JSON.stringify(result) : formatDoctorResult(result)
      );
      if (!result.passed) {
        throw new Error("Doctor checks failed.");
      }
    });

  program
    .command("init")
    .description(
      "Install or refresh package-owned pipeline support: per-machine harness (skills + slash-command adapters + agent hooks + global instruction files) installed globally to ~/.claude, ~/.config/opencode, ~/.codex with no repo-local config"
    )
    .option("--check", "verify the generated harness is current; fail if stale")
    .option("--dry-run", "show planned changes without writing files")
    .option("--force", "overwrite manually edited harness files")
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
}
