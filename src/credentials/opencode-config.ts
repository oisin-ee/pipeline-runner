import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";

import {
  applyJsonEdit,
  ensureTrailingNewline,
  formatJson,
  isRecord,
  parseJsonRecord,
} from "../json-config-merge";
import { brokerV1Url } from "./broker";
import type { BrokerCredentials } from "./broker";

const OPENCODE_OPENAI_PROVIDER_ID = "openai";
const OC_CODEX_MULTI_AUTH_PLUGIN_NAME = "oc-codex-multi-auth";

class OpencodeConfigTextError extends Schema.TaggedErrorClass<OpencodeConfigTextError>()(
  "OpencodeConfigTextError",
  {
    message: Schema.String,
  }
) {
  constructor() {
    super({ message: "opencode config text must be a string when provided." });
  }
}

/**
 * opencode host auth store contents for broker mode. Other providers in an
 * existing store are intentionally not preserved: in broker mode the runner
 * owns this credential file outright.
 */
export const renderOpencodeBrokerAuthJson = (
  credentials: BrokerCredentials
): string =>
  formatJson({
    [OPENCODE_OPENAI_PROVIDER_ID]: { key: credentials.apiKey, type: "api" },
  });

const currentOpenaiOptions = (
  parsed: Record<string, unknown>
): Record<string, unknown> => {
  const { provider } = parsed;
  if (!isRecord(provider)) {
    return {};
  }
  const openai = provider[OPENCODE_OPENAI_PROVIDER_ID];
  if (!isRecord(openai)) {
    return {};
  }
  return isRecord(openai.options) ? openai.options : {};
};

const mergeOpenaiOptions = (
  parsed: Record<string, unknown>,
  options: Record<string, unknown>
): Record<string, unknown> => ({ ...currentOpenaiOptions(parsed), ...options });

const isMultiAuthPlugin = (entry: unknown): boolean => {
  const specifier = Array.isArray(entry) ? entry[0] : entry;
  if (!P.isString(specifier)) {
    return false;
  }
  const name = specifier.includes("@", 1)
    ? specifier.slice(0, specifier.indexOf("@", 1))
    : specifier;
  return name === OC_CODEX_MULTI_AUTH_PLUGIN_NAME;
};

const pluginsWithoutMultiAuth = (plugin: unknown): Option.Option<unknown[]> => {
  if (!Array.isArray(plugin)) {
    return Option.none();
  }
  const filtered = plugin.filter((entry) => !isMultiAuthPlugin(entry));
  return filtered.length === plugin.length
    ? Option.none()
    : Option.some(filtered);
};

/**
 * Point an opencode config at the broker while preserving unrelated config.
 * Removes `oc-codex-multi-auth`; broker mode owns refresh/rotation/failover.
 */
export const applyOpencodeBrokerProvider = (
  currentText: unknown,
  credentials: BrokerCredentials
): { content: string } | { error: string } => {
  const configText = Option.match(Option.fromUndefinedOr(currentText), {
    onNone: () => "",
    onSome: (value) => {
      if (!P.isString(value)) {
        throw new OpencodeConfigTextError();
      }
      return value;
    },
  });
  const options = {
    baseURL: brokerV1Url(credentials),
    include: ["reasoning.encrypted_content"],
    store: false,
  };
  if (configText === "") {
    return {
      content: formatJson({
        $schema: "https://opencode.ai/config.json",
        provider: {
          [OPENCODE_OPENAI_PROVIDER_ID]: { options },
        },
      }),
    };
  }
  const parsed = parseJsonRecord(configText);
  if (!parsed.ok) {
    return { error: "invalid opencode config JSON" };
  }
  const withProvider = applyJsonEdit(
    configText,
    ["provider", OPENCODE_OPENAI_PROVIDER_ID, "options"],
    mergeOpenaiOptions(parsed.value, options)
  );
  const nextPlugins = pluginsWithoutMultiAuth(parsed.value.plugin);
  const withPlugins = Option.match(nextPlugins, {
    onNone: () => withProvider,
    onSome: (plugins) => applyJsonEdit(withProvider, ["plugin"], plugins),
  });
  return { content: ensureTrailingNewline(withPlugins) };
};
