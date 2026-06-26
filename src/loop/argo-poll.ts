import { CustomObjectsApi, KubeConfig } from "@kubernetes/client-node";
import { Duration, Effect } from "effect";
import { isRecord } from "../safe-json";

// ──────────────────────────────────────────────────────────────────────────────
// Phase types
// ──────────────────────────────────────────────────────────────────────────────

/** Workflow is still executing. Empty string = Argo pending (not yet scheduled). */
export type RunningPhase = "Running" | "Pending" | ""; // quality-gate:allow RunningPhase is a union-narrowed type; "" is the Argo spec's pre-scheduled/pending literal

/**
 * The blank string Argo uses before a workflow is scheduled.
 * Named constant avoids bare string-literal repetition in call sites and tests.
 */
export const ARGO_PENDING_PHASE: RunningPhase = "";

/** Workflow has reached a terminal state — no further polling required. */
export type TerminalPhase = "Succeeded" | "Failed" | "Error";

/** All phases Argo Workflow may report. */
export type WorkflowPhase = RunningPhase | TerminalPhase;

const TERMINAL_PHASES: ReadonlySet<string> = new Set([
  "Succeeded",
  "Failed",
  "Error",
]);

const KNOWN_RUNNING_PHASES: ReadonlySet<string> = new Set([
  "Running",
  "Pending",
  "",
]);

function isTerminal(phase: WorkflowPhase): phase is TerminalPhase {
  return TERMINAL_PHASES.has(phase);
}

/** Exported for reuse in KubernetesArgoService. */
export function classifyArgoPhase(raw: string): WorkflowPhase {
  return classifyPhase(raw);
}

function classifyPhase(raw: string): WorkflowPhase {
  if (TERMINAL_PHASES.has(raw)) {
    if (raw === "Succeeded") {
      return "Succeeded";
    }
    if (raw === "Failed") {
      return "Failed";
    }
    return "Error";
  }
  if (KNOWN_RUNNING_PHASES.has(raw)) {
    if (raw === "Running") {
      return "Running";
    }
    if (raw === "Pending") {
      return "Pending";
    }
    return "";
  }
  // Unknown phase (e.g. future Argo additions): treat as non-terminal so polling continues.
  return "Running";
}

// ──────────────────────────────────────────────────────────────────────────────
// DI seam for the k8s client
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Minimal slice of CustomObjectsApi needed to read an Argo Workflow.
 * Kept narrow so tests can inject a trivial fake without constructing a full
 * KubeConfig or hitting a real cluster.
 */
export interface WorkflowReadApi {
  getNamespacedCustomObject(param: {
    group: string;
    name: string;
    namespace: string;
    plural: string;
    version: string;
  }): Promise<unknown>;
}

interface KubernetesClientOptions {
  /** Explicit kubeconfig path. Falls back to loadFromDefault() (in-cluster SA) when absent. */
  kubeconfigPath?: string;
}

function buildWorkflowReadApi(
  options: KubernetesClientOptions
): WorkflowReadApi {
  const kc = new KubeConfig();
  if (options.kubeconfigPath) {
    kc.loadFromFile(options.kubeconfigPath);
  } else {
    kc.loadFromDefault();
  }
  return kc.makeApiClient(CustomObjectsApi);
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase reader
// ──────────────────────────────────────────────────────────────────────────────

interface GetWorkflowPhaseOptions {
  namespace: string;
  workflowName: string;
  workflowReadApi: WorkflowReadApi;
}

/**
 * Fetch the Argo Workflow object and extract `.status.phase`.
 * Unknown phase values are mapped to Running so the poll loop continues
 * until Argo reports a known terminal phase.
 */
function getWorkflowPhase(
  options: GetWorkflowPhaseOptions
): Effect.Effect<WorkflowPhase, unknown> {
  return Effect.tryPromise({
    catch: (error) => error,
    try: () =>
      options.workflowReadApi.getNamespacedCustomObject({
        group: "argoproj.io",
        name: options.workflowName,
        namespace: options.namespace,
        plural: "workflows",
        version: "v1alpha1",
      }),
  }).pipe(Effect.map((resource) => classifyPhase(extractRawPhase(resource))));
}

/**
 * Walk the k8s response record with isRecord guards and pull out the raw phase string.
 * Returns "" (Argo pending) when the field is absent or not a string.
 * Exported for reuse in KubernetesArgoService.
 */
export function extractArgoRawPhase(resource: unknown): string {
  return extractRawPhase(resource);
}

function extractRawPhase(resource: unknown): string {
  if (!isRecord(resource)) {
    return "";
  }
  const status = resource.status;
  if (!isRecord(status)) {
    return "";
  }
  const phase = status.phase;
  return typeof phase === "string" ? phase : "";
}

// ──────────────────────────────────────────────────────────────────────────────
// Poller
// ──────────────────────────────────────────────────────────────────────────────

export interface PollWorkflowPhaseOptions {
  /** Kubeconfig path forwarded to buildWorkflowReadApi when workflowReadApi is absent. */
  kubeconfigPath?: string;
  /** Max consecutive k8s API errors before failing the Effect. Defaults to 10. */
  maxRetries?: number;
  namespace: string;
  /** Called on each transient API error before the retry sleep. Use for structured logging. */
  onTransientError?: (error: unknown, attempt: number) => void;
  /** Milliseconds between poll attempts. Defaults to 5 000. */
  pollIntervalMs?: number;
  workflowName: string;
  /** Inject a pre-built API client; if absent, one is built from kubeconfigPath / loadFromDefault(). */
  workflowReadApi?: WorkflowReadApi;
}

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_MAX_RETRIES = 10;
const RETRY_BASE_DELAY_MS = 250;

/**
 * Poll an Argo Workflow until it reaches a terminal phase (Succeeded/Failed/Error).
 *
 * Transient k8s API errors are retried with exponential backoff up to maxRetries
 * times, and reported via onTransientError on each attempt. Exhausted budget
 * fails the Effect with the last error — never silently resolves to a fake terminal.
 *
 * Uses in-cluster service-account auth by default (loadFromDefault()); pass
 * kubeconfigPath to override, or inject workflowReadApi directly for testing.
 */
export function pollWorkflowPhaseUntilTerminal(
  options: PollWorkflowPhaseOptions
): Effect.Effect<TerminalPhase, unknown> {
  const api =
    options.workflowReadApi ??
    buildWorkflowReadApi({ kubeconfigPath: options.kubeconfigPath });
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  return pollLoop({
    namespace: options.namespace,
    workflowName: options.workflowName,
    workflowReadApi: api,
    pollIntervalMs,
    maxRetries,
    onTransientError: options.onTransientError,
    errorCount: 0,
  });
}

interface PollLoopState {
  /** Running count of consecutive k8s API errors. Reset to 0 on a successful read. */
  errorCount: number;
  maxRetries: number;
  namespace: string;
  onTransientError: PollWorkflowPhaseOptions["onTransientError"];
  pollIntervalMs: number;
  workflowName: string;
  workflowReadApi: WorkflowReadApi;
}

function pollLoop(state: PollLoopState): Effect.Effect<TerminalPhase, unknown> {
  return getWorkflowPhase({
    namespace: state.namespace,
    workflowName: state.workflowName,
    workflowReadApi: state.workflowReadApi,
  }).pipe(
    Effect.flatMap((phase) => {
      if (isTerminal(phase)) {
        return Effect.succeed(phase);
      }
      // Non-terminal: sleep then poll again with a fresh error count.
      return Effect.sleep(Duration.millis(state.pollIntervalMs)).pipe(
        Effect.andThen(pollLoop({ ...state, errorCount: 0 }))
      );
    }),
    Effect.catch((error) => handlePollError(state, error))
  );
}

function handlePollError(
  state: PollLoopState,
  error: unknown
): Effect.Effect<TerminalPhase, unknown> {
  const nextErrorCount = state.errorCount + 1;
  state.onTransientError?.(error, nextErrorCount);

  if (nextErrorCount > state.maxRetries) {
    return Effect.fail(error);
  }

  const delay = Duration.millis(
    RETRY_BASE_DELAY_MS * 2 ** (nextErrorCount - 1)
  );
  return Effect.sleep(delay).pipe(
    Effect.andThen(pollLoop({ ...state, errorCount: nextErrorCount }))
  );
}
