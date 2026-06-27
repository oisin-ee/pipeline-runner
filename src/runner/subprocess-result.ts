import type { AgentResult } from "../runner";
import type {
  ProtectedPathGuard,
  ProtectedPathViolation,
} from "../runtime/protected-paths/protected-paths";

interface SubprocessResultLike {
  exitCode?: number;
  stderr?: string;
  stdout?: string;
}

interface SubprocessErrorDetails {
  exitCode?: number;
  stderr?: string;
  stdout?: string;
  timedOut?: boolean;
}

export function completedSubprocessResult(
  argv: string[],
  result: SubprocessResultLike
): AgentResult {
  return {
    argv,
    exitCode: result.exitCode ?? 0,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

export function failedSubprocessResult(
  argv: string[],
  error: unknown
): AgentResult {
  const details = subprocessErrorDetails(error);
  return {
    argv,
    exitCode: details.exitCode ?? 1,
    stderr: details.stderr ?? "",
    stdout: details.stdout ?? "",
    timedOut: details.timedOut === true,
  };
}

export function finalizeLaunchResult(
  result: AgentResult,
  guard: ProtectedPathGuard,
  cleanupError: string | undefined
): AgentResult {
  const violations = guard.verifyAndRestore();
  const violationMessage = protectedPathViolationMessage(violations);
  const stderr = [result.stderr, violationMessage, cleanupError]
    .filter(Boolean)
    .join("\n");
  const exitCode =
    violations.length > 0 && result.exitCode === 0
      ? PROTECTED_PATH_VIOLATION_EXIT_CODE
      : result.exitCode;
  return { ...result, exitCode, stderr };
}

function subprocessErrorDetails(error: unknown): SubprocessErrorDetails {
  if (!isRecord(error)) {
    return {};
  }
  return {
    exitCode: optionalNumber(error.exitCode),
    stderr: optionalString(error.stderr),
    stdout: optionalString(error.stdout),
    timedOut: optionalBoolean(error.timedOut),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

// PIPE-90.12: a protected-path tampering attempt is a genuine task failure
// (reward-hacking), not an infra fault -- exit 1 so Argo does not reschedule.
const PROTECTED_PATH_VIOLATION_EXIT_CODE = 1;

function protectedPathViolationMessage(
  violations: readonly ProtectedPathViolation[]
): string {
  if (violations.length === 0) {
    return "";
  }
  const detail = violations
    .map((violation) => `${violation.path} (${violation.kind})`)
    .join(", ");
  return `Protected-path violation: the agent modified read-only acceptance criteria or adjudicating tests (${detail}); the changes were reverted and the node failed.`;
}
