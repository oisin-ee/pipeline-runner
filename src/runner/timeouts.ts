export function agentTimeoutMsFromEnv(): number | undefined {
  const raw = process.env.PIPELINE_AGENT_TIMEOUT_MS;
  if (!raw) {
    return;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// Default-on idle budget for opencode sessions. Unset env keeps the 180s
// default; an explicit `0` or invalid value disables the idle watchdog.
const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 180_000;

export function agentIdleTimeoutMsFromEnv(): number | undefined {
  const raw = process.env.PIPELINE_AGENT_IDLE_TIMEOUT_MS;
  if (raw === undefined) {
    return DEFAULT_AGENT_IDLE_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function timeoutOption(
  timeoutMs: number | undefined
): { timeout: number } | Record<string, never> {
  return timeoutMs === undefined ? {} : { timeout: timeoutMs };
}
