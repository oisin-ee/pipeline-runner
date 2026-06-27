import { type Command, Option } from "commander";
import { loadPipelineConfig } from "../config";
import { renderGatewayConfig } from "../mcp/gateway-config";
import { runGatewayDoctor } from "../mcp/gateway-doctor";
import {
  localGatewayStatus,
  reconcileGateway,
  startLocalGateway,
} from "../mcp/gateway-reconcile";
import {
  configureGatewayHosts,
  type GatewayHostScope,
  type GatewayHostSelection,
} from "../mcp/host-config";
import { formatDoctorResult } from "./format";

interface GatewayConfigureHostFlags {
  host?: GatewayHostSelection;
  scope?: GatewayHostScope;
}

interface GatewayLocalStartFlags {
  detach?: boolean;
}

export function registerMcpGatewayCommands(program: Command): void {
  const gatewayCommand = program
    .command("mcp")
    .description("Manage the hosted-first MCP gateway")
    .command("gateway")
    .description("Inspect and configure the pipeline MCP gateway");

  gatewayCommand
    .command("doctor")
    .description(
      "Check MCP gateway configuration and legacy direct MCP entries"
    )
    .action(async () => {
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      const config = loadPipelineConfig(cwd, {
        allowMissingLintFileReferences: true,
      });
      const result = await runGatewayDoctor(config, cwd);
      console.log(formatDoctorResult(result));
      if (!result.passed) {
        throw new Error("MCP gateway doctor checks failed.");
      }
    });

  gatewayCommand
    .command("config")
    .description("Print resolved MCP gateway client configuration")
    .action(() => {
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      const config = loadPipelineConfig(cwd, {
        allowMissingLintFileReferences: true,
      });
      console.log(renderGatewayConfig(config));
    });

  gatewayCommand
    .command("configure-host")
    .description("Rewrite host MCP config to the singleton pipeline gateway")
    .addOption(
      new Option("--host <host>", "host config to update")
        .choices(["all", "opencode"])
        .default("all")
        .argParser(parseGatewayHost)
    )
    .addOption(
      new Option("--scope <scope>", "config scope to update")
        .choices(["project", "global"])
        .default("project")
        .argParser(parseGatewayHostScope)
    )
    .action((flags: GatewayConfigureHostFlags) => {
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      const config = loadPipelineConfig(cwd, {
        allowMissingLintFileReferences: true,
      });
      const result = configureGatewayHosts(config, {
        cwd,
        host: flags.host ?? "all",
        scope: flags.scope ?? "project",
      });
      console.log(
        result
          .map((item) =>
            [
              `${item.host}: ${item.path}`,
              item.backupPath ? `backup=${item.backupPath}` : "backup=none",
            ].join(" ")
          )
          .join("\n")
      );
    });

  gatewayCommand
    .command("reconcile")
    .description("Apply the current workspace gateway backend inventory")
    .action(async () => {
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      const config = loadPipelineConfig(cwd, {
        allowMissingLintFileReferences: true,
      });
      const result = await reconcileGateway(config, cwd);
      console.log(
        [
          `workspace=${result.workspacePath}`,
          `config=${result.configPath}`,
          `backends=${result.backendCount}`,
          result.readinessFailures.length > 0
            ? `readiness_failures=${result.readinessFailures.join("; ")}`
            : "readiness_failures=none",
        ].join("\n")
      );
    });

  gatewayCommand
    .command("local-start")
    .description("Start a local ToolHive vMCP gateway for local mode")
    .option("--detach", "reserved for future background startup", false)
    .action(async (flags: GatewayLocalStartFlags) => {
      if (flags.detach) {
        throw new Error("Detached local gateway startup is not implemented.");
      }
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      const config = loadPipelineConfig(cwd, {
        allowMissingLintFileReferences: true,
      });
      await startLocalGateway(config, cwd);
    });

  gatewayCommand
    .command("local-status")
    .description("Show local ToolHive MCP server status")
    .action(async () => {
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      console.log(await localGatewayStatus(cwd));
    });
}

function parseGatewayHostScope(value: string): GatewayHostScope {
  if (value === "project" || value === "global") {
    return value;
  }
  throw new Error("scope must be project or global");
}

function parseGatewayHost(value: string): GatewayHostSelection {
  if (value === "all" || value === "opencode") {
    return value;
  }
  throw new Error("host must be all or opencode");
}
