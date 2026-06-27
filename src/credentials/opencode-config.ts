import {
  applyJsonEdit,
  ensureTrailingNewline,
  formatJson,
  isRecord,
  parseJsonRecord,
} from "../json-config-merge";
import { type BrokerCredentials, brokerV1Url } from "./broker";

const OPENCODE_OPENAI_PROVIDER_ID = "openai";
const OC_CODEX_MULTI_AUTH_PLUGIN_NAME = "oc-codex-multi-auth";

/**
 * opencode host auth store contents for broker mode. Other providers in an
 * existing store are intentionally not preserved: in broker mode the runner
 * owns this credential file outright.
 */
export function renderOpencodeBrokerAuthJson(
  credentials: BrokerCredentials
): string {
  return formatJson({
    [OPENCODE_OPENAI_PROVIDER_ID]: { key: credentials.apiKey, type: "api" },
  });
}

/**
 * Point an opencode config at the broker while preserving unrelated config.
 * Removes `oc-codex-multi-auth`; broker mode owns refresh/rotation/failover.
 */
export function applyOpencodeBrokerProvider(
  currentText: string | undefined,
  credentials: BrokerCredentials
): { content: string } | { error: string } {
  const options = {
    baseURL: brokerV1Url(credentials),
    include: ["reasoning.encrypted_content"],
    store: false,
  };
  if (currentText === undefined) {
    return {
      content: formatJson({
        $schema: "https://opencode.ai/config.json",
        provider: {
          [OPENCODE_OPENAI_PROVIDER_ID]: { options },
        },
      }),
    };
  }
  const parsed = parseJsonRecord(currentText);
  if (!parsed.ok) {
    return { error: "invalid opencode config JSON" };
  }
  const withProvider = applyJsonEdit(
    currentText,
    ["provider", OPENCODE_OPENAI_PROVIDER_ID, "options"],
    mergeOpenaiOptions(parsed.value, options)
  );
  const nextPlugins = pluginsWithoutMultiAuth(parsed.value.plugin);
  const withPlugins =
    nextPlugins === undefined
      ? withProvider
      : applyJsonEdit(withProvider, ["plugin"], nextPlugins);
  return { content: ensureTrailingNewline(withPlugins) };
}

function mergeOpenaiOptions(
  parsed: Record<string, unknown>,
  options: Record<string, unknown>
): Record<string, unknown> {
  return { ...currentOpenaiOptions(parsed), ...options };
}

function currentOpenaiOptions(
  parsed: Record<string, unknown>
): Record<string, unknown> {
  const provider = parsed.provider;
  if (!isRecord(provider)) {
    return {};
  }
  const openai = provider[OPENCODE_OPENAI_PROVIDER_ID];
  if (!isRecord(openai)) {
    return {};
  }
  return isRecord(openai.options) ? openai.options : {};
}

function pluginsWithoutMultiAuth(plugin: unknown): unknown[] | undefined {
  if (!Array.isArray(plugin)) {
    return;
  }
  const filtered = plugin.filter((entry) => !isMultiAuthPlugin(entry));
  return filtered.length === plugin.length ? undefined : filtered;
}

function isMultiAuthPlugin(entry: unknown): boolean {
  const specifier = Array.isArray(entry) ? entry[0] : entry;
  if (typeof specifier !== "string") {
    return false;
  }
  const name =
    specifier.indexOf("@", 1) === -1
      ? specifier
      : specifier.slice(0, specifier.indexOf("@", 1));
  return name === OC_CODEX_MULTI_AUTH_PLUGIN_NAME;
}
