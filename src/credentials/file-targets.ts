import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  CODEX_CONFIG_PATH,
  OPENCODE_PROJECT_CONFIG_PATH,
  resolveHarnessTarget,
} from "../install-commands/shared";

const AUTH_FILE_NAME = "auth.json";

export interface BrokerConfigPaths {
  codexConfigPath: string;
  opencodeAuthPath: string;
  opencodeConfigPath: string;
}

export function defaultBrokerConfigPaths(): BrokerConfigPaths {
  return {
    codexConfigPath: resolveHarnessTarget(CODEX_CONFIG_PATH),
    opencodeAuthPath: join(
      homedir(),
      ".local",
      "share",
      "opencode",
      AUTH_FILE_NAME
    ),
    opencodeConfigPath: resolveHarnessTarget(OPENCODE_PROJECT_CONFIG_PATH),
  };
}

export function readTextIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

export function writeCredentialFile(
  path: string,
  content: string,
  mode?: number
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, mode === undefined ? undefined : { mode });
  if (mode !== undefined) {
    chmodSync(path, mode);
  }
}

export function writtenFileName(path: string): string {
  return basename(path);
}
