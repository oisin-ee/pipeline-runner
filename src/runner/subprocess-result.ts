import { getOrUndefined } from "effect/Option";
import type { Option } from "effect/Option";

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

export const completedSubprocessResult = (
  argv: string[],
  result: SubprocessResultLike
): AgentResult => ({
  argv,
  exitCode: result.exitCode ?? 0,
  stderr: result.stderr ?? "",
  stdout: result.stdout ?? "",
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const optionalNumber = (value: unknown) =>
  typeof value === "number" ? value : undefined;

const optionalString = (value: unknown) =>
  typeof value === "string" ? value : undefined;

const optionalBoolean = (value: unknown) =>
  typeof value === "boolean" ? value : undefined;

const subprocessErrorDetails = (error: unknown): SubprocessErrorDetails => {
  if (!isRecord(error)) {
    return {};
  }
  return {
    exitCode: optionalNumber(error.exitCode),
    stderr: optionalString(error.stderr),
    stdout: optionalString(error.stdout),
    timedOut: optionalBoolean(error.timedOut),
  };
};

export const failedSubprocessResult = (
  argv: string[],
  error: unknown
): AgentResult => {
  const details = subprocessErrorDetails(error);
  return {
    argv,
    exitCode: details.exitCode ?? 1,
    stderr: details.stderr ?? "",
    stdout: details.stdout ?? "",
    timedOut: details.timedOut === true,
  };
};

// PIPE-90.12: a protected-path tampering attempt is a genuine task failure
// (reward-hacking), not an infra fault -- exit 1 so Argo does not reschedule.
const PROTECTED_PATH_VIOLATION_EXIT_CODE = 1;

const protectedPathViolationMessage = (
  violations: readonly ProtectedPathViolation[]
): string => {
  if (violations.length === 0) {
    return "";
  }
  const detail = violations
    .map((violation) => `${violation.path} (${violation.kind})`)
    .join(", ");
  return `Protected-path violation: the agent modified read-only acceptance criteria or adjudicating tests (${detail}); the changes were reverted and the node failed.`;
};

export const finalizeLaunchResult = (
  result: AgentResult,
  guard: ProtectedPathGuard,
  cleanupError: Option<string>
): AgentResult => {
  const violations = guard.verifyAndRestore();
  const violationMessage = protectedPathViolationMessage(violations);
  const stderr = [result.stderr, violationMessage, getOrUndefined(cleanupError)]
    .filter(Boolean)
    .join("\n");
  const exitCode =
    violations.length > 0 && result.exitCode === 0
      ? PROTECTED_PATH_VIOLATION_EXIT_CODE
      : result.exitCode;
  return { ...result, exitCode, stderr };
};
