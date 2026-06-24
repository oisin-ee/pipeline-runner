import { z } from "zod";
import {
  applyJsonEdit,
  ensureTrailingNewline,
  formatJson,
  parseJsonRecord,
} from "./json-config-merge";

/**
 * Central CLIProxyAPI broker auth for codex + opencode.
 *
 * When `BROKER_API_KEY` is present, codex and opencode authenticate through the
 * central broker (an OpenAI-compatible `/v1` endpoint) instead of materializing
 * the bespoke multi-auth account pool. The broker owns OAuth refresh / rotation
 * / failover, so the runner no longer stages `oc-codex-multi-auth` accounts, the
 * mounted `~/.codex/auth.json`, or the multi-auth opencode plugin.
 *
 * This mirrors the proven coder dev-workspace template
 * (infra: coder-templates/dev-workspace/main.tf):
 *   - codex  ~/.codex/config.toml: `model_provider = "broker"` +
 *     `[model_providers.broker]` base_url=<broker>/v1 env_key=BROKER_API_KEY
 *     wire_api="responses".
 *   - opencode global config: `provider.openai.options.baseURL=<broker>/v1`
 *     plus `store=false` and `include=["reasoning.encrypted_content"]` (required
 *     by the Codex/Responses backend the broker fronts).
 *   - opencode auth store: `{"openai":{"type":"api","key":<BROKER_API_KEY>}}`.
 */

const BROKER_API_KEY_ENV = "BROKER_API_KEY";
const BROKER_URL_ENV = "BROKER_URL";
const DEFAULT_BROKER_URL = "https://cliproxy.momokaya.ee";
const TRAILING_SLASH_RE = /\/+$/;

const CODEX_BROKER_PROVIDER_ID = "broker";
const OPENCODE_OPENAI_PROVIDER_ID = "openai";
/** Plugin removed from opencode config in broker mode (broker fronts auth). */
const OC_CODEX_MULTI_AUTH_PLUGIN_NAME = "oc-codex-multi-auth";

export interface BrokerCredentials {
  /** Inbound api-key the runner presents to the broker. */
  apiKey: string;
  /** Broker origin (no trailing slash), e.g. https://cliproxy.momokaya.ee. */
  baseUrl: string;
}

/**
 * Submit-time broker auth options: the runner sources BROKER_API_KEY from
 * `secretName[secretKey]` and BROKER_URL from `url`. Shared by every submit
 * entrypoint so the broker wiring is declared in exactly one place.
 */
export const brokerAuthOptionSchema = z
  .object({
    secretKey: z.string().min(1).default("api-key"),
    secretName: z.string().min(1),
    url: z.string().min(1).default(DEFAULT_BROKER_URL),
  })
  .strict();

export type BrokerAuthOption = z.input<typeof brokerAuthOptionSchema>;

/**
 * Resolve broker credentials from the environment, or `undefined` when the
 * runner is not broker-authenticated (local dev, non-broker fallback). The
 * `BROKER_URL` env is optional and defaults to the production broker origin.
 */
export function resolveBrokerCredentials(
  env: NodeJS.ProcessEnv = process.env
): BrokerCredentials | undefined {
  const apiKey = env[BROKER_API_KEY_ENV];
  if (apiKey === undefined || apiKey.length === 0) {
    return;
  }
  const rawUrl = env[BROKER_URL_ENV];
  const baseUrl =
    rawUrl !== undefined && rawUrl.length > 0
      ? rawUrl.replace(TRAILING_SLASH_RE, "")
      : DEFAULT_BROKER_URL;
  return { apiKey, baseUrl };
}

/** The broker's OpenAI-compatible endpoint (`<baseUrl>/v1`). */
export function brokerV1Url(credentials: BrokerCredentials): string {
  return `${credentials.baseUrl}/v1`;
}

/**
 * opencode host auth store contents for broker mode — the `openai` provider
 * authenticates with the broker api-key. Other providers in an existing store
 * are intentionally NOT preserved here: in broker mode the runner owns this
 * file outright (the multi-auth pool that previously populated it is gone).
 */
export function renderOpencodeBrokerAuthJson(
  credentials: BrokerCredentials
): string {
  return formatJson({
    [OPENCODE_OPENAI_PROVIDER_ID]: { key: credentials.apiKey, type: "api" },
  });
}

/**
 * Inject the codex broker model provider into an existing `config.toml`,
 * preserving every other section. Idempotent: re-running replaces the
 * `[model_providers.broker]` block and the top-level `model_provider` key.
 */
export function applyCodexBrokerProvider(
  currentText: string | undefined,
  credentials: BrokerCredentials
): string {
  const withoutProvider = removeCodexBrokerSections(currentText ?? "");
  const projection = renderCodexBrokerProvider(credentials);
  return ensureTrailingNewline(
    [withoutProvider.trimEnd(), projection.trimEnd()]
      .filter(Boolean)
      .join("\n\n")
  );
}

function renderCodexBrokerProvider(credentials: BrokerCredentials): string {
  return [
    `model_provider = "${CODEX_BROKER_PROVIDER_ID}"`,
    "",
    `[model_providers.${CODEX_BROKER_PROVIDER_ID}]`,
    `name = "${CODEX_BROKER_PROVIDER_ID}"`,
    `base_url = "${brokerV1Url(credentials)}"`,
    `env_key = "${BROKER_API_KEY_ENV}"`,
    'wire_api = "responses"',
  ].join("\n");
}

const CODEX_BROKER_SECTION_HEADER = `[model_providers.${CODEX_BROKER_PROVIDER_ID}]`;
const CODEX_MODEL_PROVIDER_KEY_RE = /^\s*model_provider\s*=/;

function removeCodexBrokerSections(content: string): string {
  const lines = content.split("\n");
  const kept: string[] = [];
  let removing = false;
  for (const line of lines) {
    if (line.trim() === CODEX_BROKER_SECTION_HEADER) {
      removing = true;
      continue;
    }
    if (removing && isTomlSectionHeader(line)) {
      removing = false;
    }
    if (removing) {
      continue;
    }
    if (CODEX_MODEL_PROVIDER_KEY_RE.test(line)) {
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function isTomlSectionHeader(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("[") && trimmed.endsWith("]");
}

/**
 * Point an opencode config (global or project `opencode.json`) at the broker:
 * set `provider.openai.options.{baseURL,store,include}` and drop the
 * `oc-codex-multi-auth` plugin entry. Preserves all other config (models, mcp,
 * other plugins). Creates a minimal config when `currentText` is undefined.
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
  const existing = currentOpenaiOptions(parsed);
  return { ...existing, ...options };
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

/**
 * Return the plugin array with every `oc-codex-multi-auth` entry removed, or
 * `undefined` when there was nothing to remove (so the caller can skip the
 * edit). Handles bare-string and `[name, opts]` tuple plugin specifiers.
 */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
