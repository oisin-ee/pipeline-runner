import { ensureTrailingNewline } from "../json-config-merge";
import {
  BROKER_API_KEY_ENV,
  type BrokerCredentials,
  brokerV1Url,
} from "./broker";

const CODEX_BROKER_PROVIDER_ID = "broker";
const CODEX_BROKER_SECTION_RE =
  /\n?\[model_providers\.broker\]\n(?:[^\n]*\n?)*?(?=\n\[|$)/g;
const CODEX_MODEL_PROVIDER_KEY_RE = /^\s*model_provider\s*=/;

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

function removeCodexBrokerSections(content: string): string {
  return content
    .replace(CODEX_BROKER_SECTION_RE, "\n")
    .split("\n")
    .filter((line) => !CODEX_MODEL_PROVIDER_KEY_RE.test(line))
    .join("\n");
}
