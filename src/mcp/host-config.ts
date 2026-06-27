import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { replaceClaudeUserMcpServers } from "../claude-user-config";
import { mergeCodexConfig } from "../codex-config";
import type { PipelineConfig } from "../config";
import { PipelineMcpGatewayError } from "./gateway-error";
import {
  renderClaudeGatewayMcpServers,
  renderCodexGatewayConfig,
  renderOpenCodeGatewayConfig,
} from "./host-renderers";

export type GatewayHost = "opencode" | "claude-code" | "codex";
export type GatewayHostSelection = "all" | GatewayHost;
export type GatewayHostScope = "global" | "project";

export interface GatewayHostConfigResult {
  backupPath?: string;
  host: GatewayHost;
  path: string;
}

export interface GatewayConfigureHostOptions {
  cwd: string;
  host: GatewayHostSelection;
  scope: GatewayHostScope;
}

export function configureGatewayHosts(
  config: PipelineConfig,
  options: GatewayConfigureHostOptions
): GatewayHostConfigResult[] {
  return selectedGatewayHosts(options.host).map((host) => {
    const adapter = GATEWAY_HOST_CONFIGS[host];
    const path = adapter.path(options.scope, options.cwd);
    const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    const content = adapter.configureContent(config, current);
    const backupPath = backupIfExists(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return { backupPath, host, path };
  });
}

function selectedGatewayHosts(host: GatewayHostSelection): GatewayHost[] {
  return host === "all" ? ["opencode", "claude-code", "codex"] : [host];
}

interface GatewayHostConfigAdapter {
  configureContent: (
    config: PipelineConfig,
    current: string | undefined
  ) => string;
  path: (scope: GatewayHostScope, cwd: string) => string;
}

const GATEWAY_HOST_CONFIGS: Record<GatewayHost, GatewayHostConfigAdapter> = {
  "claude-code": {
    configureContent: (config, current) => {
      const merged = replaceClaudeUserMcpServers(current, {
        mcpServers: renderClaudeGatewayMcpServers(config),
      });
      if (!merged.ok) {
        throw new PipelineMcpGatewayError(
          "Cannot parse Claude Code user config."
        );
      }
      return merged.content;
    },
    path: claudeGatewayConfigPath,
  },
  codex: {
    configureContent: (config, current) =>
      mergeCodexConfig(current, renderCodexGatewayConfig(config)),
    path: codexGatewayConfigPath,
  },
  opencode: {
    configureContent: (config) => renderOpenCodeGatewayConfig(config),
    path: opencodeGatewayConfigPath,
  },
};

function opencodeGatewayConfigPath(
  scope: GatewayHostScope,
  cwd: string
): string {
  if (scope === "project") {
    return join(cwd, ".opencode", "opencode.json");
  }
  return join(
    process.env.OPENCODE_CONFIG_DIR ??
      join(
        process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
        "opencode"
      ),
    "opencode.json"
  );
}

function claudeGatewayConfigPath(scope: GatewayHostScope, cwd: string): string {
  if (scope === "project") {
    return join(cwd, ".mcp.json");
  }
  return join(
    dirname(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")),
    ".claude.json"
  );
}

function codexGatewayConfigPath(scope: GatewayHostScope, cwd: string): string {
  if (scope === "project") {
    return join(cwd, ".codex", "config.toml");
  }
  return join(
    process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    "config.toml"
  );
}

function backupIfExists(path: string): string | undefined {
  if (!existsSync(path)) {
    return;
  }
  const backupPath = `${path}.bak-${Date.now()}`;
  copyFileSync(path, backupPath);
  return backupPath;
}
