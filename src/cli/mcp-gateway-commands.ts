import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { loadPipelineConfig } from "../config";
import { renderGatewayConfig } from "../mcp/gateway-config";
import { runGatewayDoctor } from "../mcp/gateway-doctor";
import {
  localGatewayStatus,
  reconcileGateway,
  startLocalGateway,
} from "../mcp/gateway-reconcile";
import { configureGatewayHosts } from "../mcp/host-config";
import type {
  GatewayHostScope,
  GatewayHostSelection,
} from "../mcp/host-config";
import { formatDoctorResult, writeTerminalLog } from "./format";

interface GatewayConfigureHostFlags {
  host: GatewayHostSelection;
  scope: GatewayHostScope;
}

interface GatewayLocalStartFlags {
  detach: boolean;
}

const writeOutput = writeTerminalLog;

const gatewayConfigureHostFlags = {
  host: Flag.choice("host", ["all", "opencode"]).pipe(
    Flag.withDescription("host config to update"),
    Flag.withDefault("all")
  ),
  scope: Flag.choice("scope", ["project", "global"]).pipe(
    Flag.withDescription("config scope to update"),
    Flag.withDefault("project")
  ),
};

const localStartFlags = {
  detach: Flag.boolean("detach").pipe(
    Flag.withDescription("reserved for future background startup")
  ),
};

const gatewayDoctorCommand = Command.make("doctor", {}, () =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => {
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      const config = loadPipelineConfig(cwd, {
        allowMissingLintFileReferences: true,
      });
      const result = await runGatewayDoctor(config, cwd);
      writeOutput(formatDoctorResult(result));

      if (!result.passed) {
        throw new Error("MCP gateway doctor checks failed.");
      }
    },
  })
).pipe(
  Command.withDescription(
    "Check MCP gateway configuration and legacy direct MCP entries"
  )
);

const gatewayConfigCommand = Command.make("config", {}, () =>
  Effect.try({
    catch: (error) => error,
    try: () => {
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      const config = loadPipelineConfig(cwd, {
        allowMissingLintFileReferences: true,
      });
      writeOutput(renderGatewayConfig(config));
    },
  })
).pipe(
  Command.withDescription("Print resolved MCP gateway client configuration")
);

const configureHostCommand = Command.make(
  "configure-host",
  gatewayConfigureHostFlags,
  (flags: GatewayConfigureHostFlags) =>
    Effect.try({
      catch: (error) => error,
      try: () => {
        const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
        const config = loadPipelineConfig(cwd, {
          allowMissingLintFileReferences: true,
        });
        const result = configureGatewayHosts(config, {
          cwd,
          host: flags.host,
          scope: flags.scope,
        });
        writeOutput(
          result
            .map((entry) =>
              [
                `configured ${entry.host}: ${entry.path}`,
                entry.backupPath !== undefined && entry.backupPath !== ""
                  ? `backup=${entry.backupPath}`
                  : "",
              ]
                .filter((part) => part !== "")
                .join(" ")
            )
            .join("\n")
        );
      },
    })
).pipe(
  Command.withDescription(
    "Rewrite host MCP config to the singleton pipeline gateway"
  )
);

const reconcileCommand = Command.make("reconcile", {}, () =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => {
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      const config = loadPipelineConfig(cwd, {
        allowMissingLintFileReferences: true,
      });
      const result = await reconcileGateway(config, cwd);
      writeOutput(
        [
          `reconciled ${result.backendCount} MCP gateway backends`,
          `workspace=${result.workspacePath}`,
          `config=${result.configPath}`,
        ].join("\n")
      );
    },
  })
).pipe(
  Command.withDescription(
    "Apply the current workspace gateway backend inventory"
  )
);

const localStartCommand = Command.make(
  "local-start",
  localStartFlags,
  (flags: GatewayLocalStartFlags) =>
    Effect.tryPromise({
      catch: (error) => error,
      try: async () => {
        if (flags.detach) {
          throw new Error("Detached local gateway startup is not implemented.");
        }
        const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
        const config = loadPipelineConfig(cwd, {
          allowMissingLintFileReferences: true,
        });
        await startLocalGateway(config, cwd);
      },
    })
).pipe(
  Command.withDescription("Start a local ToolHive vMCP gateway for local mode")
);

const localStatusCommand = Command.make("local-status", {}, () =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => {
      const cwd = process.env.PIPELINE_TARGET_PATH ?? process.cwd();
      writeOutput(await localGatewayStatus(cwd));
    },
  })
).pipe(Command.withDescription("Show local ToolHive MCP server status"));

const gatewayCommand = Command.make("gateway").pipe(
  Command.withDescription("Inspect and configure the pipeline MCP gateway"),
  Command.withSubcommands([
    gatewayDoctorCommand,
    gatewayConfigCommand,
    configureHostCommand,
    reconcileCommand,
    localStartCommand,
    localStatusCommand,
  ])
);

export const createMcpGatewayCommand = () =>
  Command.make("mcp").pipe(
    Command.withDescription("Manage the hosted-first MCP gateway"),
    Command.withSubcommands([gatewayCommand])
  );
