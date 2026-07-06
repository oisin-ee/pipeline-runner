import * as Option from "effect/Option";

import { requiredString, withDefault, struct } from "../schema-boundary";

const DEFAULT_BROKER_URL = "https://cliproxy.momokaya.ee";
const TRAILING_SLASH_RE = /\/+$/u;

export const BROKER_API_KEY_ENV = "BROKER_API_KEY";
const BROKER_URL_ENV = "BROKER_URL";

export interface BrokerCredentials {
  /** Inbound api-key the runner presents to the broker. Never print this object. */
  apiKey: string;
  /** Broker origin (no trailing slash), e.g. https://cliproxy.momokaya.ee. */
  baseUrl: string;
}

/**
 * Submit-time broker auth options: the runner sources BROKER_API_KEY from
 * `secretName[secretKey]` and BROKER_URL from `url`.
 */
export const brokerAuthOptionSchema = struct({
  secretKey: withDefault(requiredString, "api-key"),
  secretName: requiredString,
  url: withDefault(requiredString, DEFAULT_BROKER_URL),
});

export type BrokerAuthOption = typeof brokerAuthOptionSchema.Encoded;

/**
 * Trust boundary for local/runner broker credentials. The raw api-key may enter
 * only from env or test injection, and exits only through credential file/env
 * writers in this module family.
 */
const brokerCredentialsOption = (env: NodeJS.ProcessEnv) => {
  const apiKey = env[BROKER_API_KEY_ENV];
  if (apiKey === undefined || apiKey === "") {
    return Option.none<BrokerCredentials>();
  }
  const baseUrl = (env[BROKER_URL_ENV] ?? DEFAULT_BROKER_URL).replace(TRAILING_SLASH_RE, "");
  return Option.some({ apiKey, baseUrl });
};

export const resolveBrokerCredentials = (env: NodeJS.ProcessEnv = process.env) =>
  Option.getOrUndefined(brokerCredentialsOption(env));

/** The broker's OpenAI-compatible endpoint (`<baseUrl>/v1`). */
export const brokerV1Url = (credentials: BrokerCredentials): string => `${credentials.baseUrl}/v1`;
