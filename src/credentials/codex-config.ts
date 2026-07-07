import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";

import { ensureTrailingNewline } from "../json-config-merge";
import { BROKER_API_KEY_ENV, brokerV1Url } from "./broker";
import type { BrokerCredentials } from "./broker";

const CODEX_BROKER_PROVIDER_ID = "broker";
const CODEX_BROKER_SECTION_RE =
  /\n?\[model_providers\.broker\]\n(?:[^\n]*\n?)*?(?=\n\[|$)/gu;
const CODEX_MODEL_PROVIDER_KEY_RE = /^\s*model_provider\s*=/u;

class CodexConfigTextError extends Schema.TaggedErrorClass<CodexConfigTextError>()(
  "CodexConfigTextError",
  {
    message: Schema.String,
  }
) {
  constructor() {
    super({ message: "Codex config text must be a string when provided." });
  }
}

const renderCodexBrokerProvider = (credentials: BrokerCredentials): string =>
  [
    `model_provider = "${CODEX_BROKER_PROVIDER_ID}"`,
    "",
    `[model_providers.${CODEX_BROKER_PROVIDER_ID}]`,
    `name = "${CODEX_BROKER_PROVIDER_ID}"`,
    `base_url = "${brokerV1Url(credentials)}"`,
    `env_key = "${BROKER_API_KEY_ENV}"`,
    'wire_api = "responses"',
  ].join("\n");

const removeCodexBrokerSections = (content: string): string =>
  content
    .replace(CODEX_BROKER_SECTION_RE, "\n")
    .split("\n")
    .filter((line) => !CODEX_MODEL_PROVIDER_KEY_RE.test(line))
    .join("\n");

/**
 * Inject the codex broker model provider into an existing `config.toml`,
 * preserving every other section. Idempotent: re-running replaces the
 * `[model_providers.broker]` block and the top-level `model_provider` key.
 */
export const applyCodexBrokerProvider = (
  currentText: unknown,
  credentials: BrokerCredentials
): string => {
  const configText = Option.match(Option.fromUndefinedOr(currentText), {
    onNone: () => "",
    onSome: (value) => {
      if (!P.isString(value)) {
        throw new CodexConfigTextError();
      }
      return value;
    },
  });
  const withoutProvider = removeCodexBrokerSections(configText);
  const projection = renderCodexBrokerProvider(credentials);
  return ensureTrailingNewline(
    [withoutProvider.trimEnd(), projection.trimEnd()]
      .filter(Boolean)
      .join("\n\n")
  );
};
