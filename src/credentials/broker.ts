import { z } from "zod";

const DEFAULT_BROKER_URL = "https://cliproxy.momokaya.ee";
const TRAILING_SLASH_RE = /\/+$/;

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
export const brokerAuthOptionSchema = z
  .object({
    secretKey: z.string().min(1).default("api-key"),
    secretName: z.string().min(1),
    url: z.string().min(1).default(DEFAULT_BROKER_URL),
  })
  .strict();

export type BrokerAuthOption = z.input<typeof brokerAuthOptionSchema>;

/**
 * Trust boundary for local/runner broker credentials. The raw api-key may enter
 * only from env or test injection, and exits only through credential file/env
 * writers in this module family.
 */
export function resolveBrokerCredentials(
  env: NodeJS.ProcessEnv = process.env
): BrokerCredentials | undefined {
  const apiKey = env[BROKER_API_KEY_ENV];
  if (!apiKey) {
    return;
  }
  const baseUrl = (env[BROKER_URL_ENV] || DEFAULT_BROKER_URL).replace(
    TRAILING_SLASH_RE,
    ""
  );
  return { apiKey, baseUrl };
}

/** The broker's OpenAI-compatible endpoint (`<baseUrl>/v1`). */
export function brokerV1Url(credentials: BrokerCredentials): string {
  return `${credentials.baseUrl}/v1`;
}
