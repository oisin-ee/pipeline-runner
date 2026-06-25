import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  applyCodexBrokerProvider,
  applyOpencodeBrokerProvider,
  type BrokerCredentials,
  renderOpencodeBrokerAuthJson,
  resolveBrokerCredentials,
} from "../broker-auth";
import { resolveHarnessTarget } from "../install-commands/shared";

/*
 * Runner credential preparation for codex + opencode — BROKER ONLY.
 *
 * codex and opencode authenticate through the central CLIProxyAPI broker. The
 * runner writes the broker provider into codex's config.toml, points opencode's
 * openai provider baseURL at the broker, and writes the broker api-key into
 * opencode's auth.json. The broker owns OAuth refresh / rotation / failover, so
 * there is no bespoke multi-auth account-pool staging: every runner workflow is
 * submitted with BROKER_API_KEY (verified fleet-wide), and the legacy
 * oc-codex-multi-auth pool path has been decommissioned (MAA-1.19).
 */
const AUTH_FILE_NAME = "auth.json";

export interface PrepareOpencodeCredentialsOptions {
  /**
   * Test override: resolved broker credentials. When omitted, resolved from the
   * environment.
   */
  broker?: BrokerCredentials;
  /** Test override: destination paths for the broker config writers. */
  brokerPaths?: BrokerConfigPaths;
}

export interface PrepareOpencodeCredentialsResult {
  /** Auth/config files written by broker mode (basenames). */
  brokerConfigured: string[];
}

interface BrokerConfigPaths {
  codexConfigPath: string;
  opencodeAuthPath: string;
  opencodeConfigPath: string;
}

/**
 * Prepare codex + opencode runner credentials through the central broker: write
 * the broker provider config and api-key. Requires BROKER_API_KEY in the env (or
 * an explicit `broker` override); throws otherwise, since the runner has no
 * other auth path.
 */
export function prepareOpencodeCredentials(
  options: PrepareOpencodeCredentialsOptions = {}
): PrepareOpencodeCredentialsResult {
  const broker =
    options.broker === undefined ? resolveBrokerCredentials() : options.broker;
  if (!broker) {
    throw new Error(
      "BROKER_API_KEY is required: codex + opencode authenticate through the central CLIProxyAPI broker."
    );
  }
  return {
    brokerConfigured: configureBrokerCredentials(broker, options.brokerPaths),
  };
}

function defaultBrokerConfigPaths(): BrokerConfigPaths {
  return {
    // resolveHarnessTarget honors CODEX_HOME / OPENCODE_CONFIG_DIR so the same
    // writers target the right dirs in the runner, in tests, and locally.
    codexConfigPath: resolveHarnessTarget(".codex/config.toml"),
    opencodeAuthPath: join(
      homedir(),
      ".local",
      "share",
      "opencode",
      AUTH_FILE_NAME
    ),
    opencodeConfigPath: resolveHarnessTarget(".opencode/opencode.json"),
  };
}

function configureBrokerCredentials(
  broker: BrokerCredentials,
  pathsOverride?: BrokerConfigPaths
): string[] {
  const paths = pathsOverride ?? defaultBrokerConfigPaths();
  const configured: string[] = [];

  writeFileEnsured(
    paths.opencodeAuthPath,
    renderOpencodeBrokerAuthJson(broker),
    0o600
  );
  configured.push(basename(paths.opencodeAuthPath));

  writeFileEnsured(
    paths.codexConfigPath,
    applyCodexBrokerProvider(readIfExists(paths.codexConfigPath), broker)
  );
  configured.push(basename(paths.codexConfigPath));

  const opencodeConfig = applyOpencodeBrokerProvider(
    readIfExists(paths.opencodeConfigPath),
    broker
  );
  if ("error" in opencodeConfig) {
    throw new Error(
      `Cannot configure opencode broker provider: ${opencodeConfig.error}`
    );
  }
  writeFileEnsured(paths.opencodeConfigPath, opencodeConfig.content);
  configured.push(basename(paths.opencodeConfigPath));

  return configured;
}

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function writeFileEnsured(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, mode === undefined ? undefined : { mode });
}
