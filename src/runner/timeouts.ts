import { match as matchOption, none, some } from "effect/Option";
import type { Option } from "effect/Option";

const positiveNumberOption = (value: number): Option<number> =>
  Number.isFinite(value) && value > 0 ? some(value) : none();

export const agentTimeoutMsFromEnv = (): Option<number> => {
  const raw = process.env.PIPELINE_AGENT_TIMEOUT_MS;
  if (raw === undefined || raw.length === 0) {
    return none();
  }
  return positiveNumberOption(Number(raw));
};

// Default-on idle budget for opencode sessions. Unset env keeps the 180s
// default; an explicit `0` or invalid value disables the idle watchdog.
const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 180_000;

export const agentIdleTimeoutMsFromEnv = (): Option<number> => {
  const raw = process.env.PIPELINE_AGENT_IDLE_TIMEOUT_MS;
  if (raw === undefined) {
    return some(DEFAULT_AGENT_IDLE_TIMEOUT_MS);
  }
  return positiveNumberOption(Number(raw));
};

export const timeoutOption = (
  timeoutMs: Option<number>
): { timeout: number } | Record<string, never> =>
  matchOption(timeoutMs, {
    onNone: () => ({}),
    onSome: (timeout) => ({ timeout }),
  });
