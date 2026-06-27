import type { BrokerCredentials } from "./broker";
import { resolveBrokerCredentials } from "./broker";
import { applyCodexBrokerProvider } from "./codex-config";
import {
  type BrokerConfigPaths,
  defaultBrokerConfigPaths,
  readTextIfExists,
  writeCredentialFile,
  writtenFileName,
} from "./file-targets";
import {
  applyOpencodeBrokerProvider,
  renderOpencodeBrokerAuthJson,
} from "./opencode-config";

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

function configureBrokerCredentials(
  broker: BrokerCredentials,
  pathsOverride?: BrokerConfigPaths
): string[] {
  const paths = pathsOverride ?? defaultBrokerConfigPaths();
  const configured: string[] = [];

  writeCredentialFile(
    paths.opencodeAuthPath,
    renderOpencodeBrokerAuthJson(broker),
    0o600
  );
  configured.push(writtenFileName(paths.opencodeAuthPath));

  writeCredentialFile(
    paths.codexConfigPath,
    applyCodexBrokerProvider(readTextIfExists(paths.codexConfigPath), broker)
  );
  configured.push(writtenFileName(paths.codexConfigPath));

  const opencodeConfig = applyOpencodeBrokerProvider(
    readTextIfExists(paths.opencodeConfigPath),
    broker
  );
  if ("error" in opencodeConfig) {
    throw new Error(
      `Cannot configure opencode broker provider: ${opencodeConfig.error}`
    );
  }
  writeCredentialFile(paths.opencodeConfigPath, opencodeConfig.content);
  configured.push(writtenFileName(paths.opencodeConfigPath));

  return configured;
}
