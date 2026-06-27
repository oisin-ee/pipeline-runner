import type { RuntimeContext } from "../src/runtime/contracts";
import { NodeStateStore } from "../src/runtime/node-state-store";

type BaseGateRuntimeFields = Pick<
  RuntimeContext,
  | "agentInvocations"
  | "executor"
  | "gates"
  | "hookFailures"
  | "hookPolicy"
  | "hookResults"
>;

/**
 * The runtime-context fields every gate test fills identically (a no-op
 * executor, empty accumulators, and a permissive hook policy). Shared so the
 * boilerplate lives in one place instead of being copied per test file.
 */
export function baseGateRuntimeFields(): BaseGateRuntimeFields {
  return {
    agentInvocations: [],
    executor: async () => ({ exitCode: 0, stdout: "" }),
    gates: [],
    hookFailures: [],
    hookPolicy: {
      allowCommandHooks: true,
      allowUntrustedCommandHooks: true,
      env: {},
      envPassthrough: [],
      outputLimitBytes: 1024,
      timeoutMs: 1000,
    },
    hookResults: new Map(),
  };
}

/** A {@link NodeStateStore} seeded with one node's changed-file snapshot. */
export function gateNodeStateStore(
  nodeId: string,
  files: string[]
): NodeStateStore {
  return new NodeStateStore({
    nodeSnapshots: new Map([
      [nodeId, { files: new Set(files), fingerprints: new Map() }],
    ]),
  });
}
