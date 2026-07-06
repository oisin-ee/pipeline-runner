import { describe, expect, it } from "vitest";

import type { PipelineRuntimeEvent } from "../src/pipeline-runtime";
import type { MokaNodeStatus } from "../src/run-control/contracts";
import { createRuntimeEventProjectionState, projectRuntimeEvent } from "../src/run-control/runtime-event-projection";
import type {
  RuntimeEventProjectionState,
  RuntimeEventStoreWriteIntent,
} from "../src/run-control/runtime-event-projection";

interface ProjectionCase {
  events: PipelineRuntimeEvent[];
  expectedObservedNodeStatuses?: [string, MokaNodeStatus][];
  expectedWrites: RuntimeEventStoreWriteIntent[];
  initialState?: RuntimeEventProjectionState;
  name: string;
}

const workflowStart: PipelineRuntimeEvent = {
  nodeIds: ["writer"],
  type: "workflow.start",
  workflowId: "runtime-bridge",
};

const hookStart: PipelineRuntimeEvent = {
  event: "node.finish",
  functionId: "notify",
  hookId: "notify-hooked",
  nodeId: "hooked",
  required: true,
  type: "hook.start",
  workflowId: "runtime-bridge",
};

const projectEvents = (events: PipelineRuntimeEvent[], initialState = createRuntimeEventProjectionState()) => {
  let state = initialState;
  const writes: RuntimeEventStoreWriteIntent[] = [];

  for (const event of events) {
    const projection = projectRuntimeEvent(event, state);
    state = projection.state;
    writes.push(...projection.writes);
  }

  return { state, writes };
};

const stateWithObservedStatus = (nodeId: string, status: MokaNodeStatus): RuntimeEventProjectionState => ({
  activeHookPreviousStatuses: new Map(),
  observedNodeStatuses: new Map([[nodeId, status]]),
});

const projectionCases: ProjectionCase[] = [
  {
    events: [workflowStart],
    expectedWrites: [{ status: "starting", type: "run.status" }],
    name: "projects workflow.start to run starting",
  },
  {
    events: [
      {
        outcome: "PASS",
        type: "workflow.finish",
        workflowId: "runtime-bridge",
      },
    ],
    expectedWrites: [{ status: "passed", type: "run.status" }],
    name: "projects workflow.finish PASS to run passed",
  },
  {
    events: [
      {
        attempt: 1,
        nodeId: "writer",
        profile: "code-writer",
        runnerId: "opencode",
        type: "node.start",
      },
    ],
    expectedObservedNodeStatuses: [["writer", "running"]],
    expectedWrites: [{ nodeId: "writer", status: "running", type: "node.status" }],
    name: "projects node.start to node running",
  },
  {
    events: [
      {
        attempt: 1,
        exitCode: 0,
        nodeId: "writer",
        profile: "code-writer",
        runnerId: "opencode",
        status: "passed",
        type: "node.finish",
      },
    ],
    expectedObservedNodeStatuses: [["writer", "passed"]],
    expectedWrites: [{ nodeId: "writer", status: "passed", type: "node.status" }],
    name: "projects node.finish to node terminal status",
  },
  {
    events: [
      {
        attempt: 1,
        nodeId: "agent",
        profile: "code-writer",
        runnerId: "opencode",
        type: "agent.start",
      },
      {
        attempt: 1,
        exitCode: 1,
        nodeId: "agent",
        profile: "code-writer",
        runnerId: "opencode",
        type: "agent.finish",
      },
    ],
    expectedObservedNodeStatuses: [["agent", "failed"]],
    expectedWrites: [
      { nodeId: "agent", status: "running", type: "node.status" },
      { nodeId: "agent", status: "failed", type: "node.status" },
    ],
    name: "projects agent lifecycle to running then failed",
  },
  {
    events: [
      {
        gateId: "acceptance",
        kind: "acceptance",
        nodeId: "gated",
        type: "gate.start",
      },
      {
        evidence: ["criterion failed"],
        gateId: "acceptance",
        kind: "acceptance",
        nodeId: "gated",
        passed: false,
        reason: "acceptance rejected output",
        type: "gate.finish",
      },
    ],
    expectedObservedNodeStatuses: [["gated", "blocked"]],
    expectedWrites: [
      { nodeId: "gated", status: "running", type: "node.status" },
      { nodeId: "gated", status: "blocked", type: "node.status" },
    ],
    name: "projects gate lifecycle to running then blocked",
  },
  {
    events: [
      hookStart,
      {
        event: "node.finish",
        functionId: "notify",
        hookId: "notify-hooked",
        nodeId: "hooked",
        passed: true,
        required: true,
        type: "hook.finish",
        workflowId: "runtime-bridge",
      },
    ],
    expectedObservedNodeStatuses: [["hooked", "passed"]],
    expectedWrites: [
      { nodeId: "hooked", status: "running", type: "node.status" },
      { nodeId: "hooked", status: "passed", type: "node.status" },
    ],
    initialState: stateWithObservedStatus("hooked", "passed"),
    name: "projects hook lifecycle and restores previous node status",
  },
  {
    events: [
      hookStart,
      {
        event: "node.finish",
        functionId: "notify",
        hookId: "notify-hooked",
        nodeId: "hooked",
        passed: false,
        reason: "required hook failed",
        required: true,
        type: "hook.finish",
        workflowId: "runtime-bridge",
      },
    ],
    expectedObservedNodeStatuses: [["hooked", "blocked"]],
    expectedWrites: [
      { nodeId: "hooked", status: "running", type: "node.status" },
      { nodeId: "hooked", status: "blocked", type: "node.status" },
    ],
    initialState: stateWithObservedStatus("hooked", "passed"),
    name: "projects required hook failure to node blocked",
  },
  {
    events: [
      {
        event: "node.finish",
        functionId: "notify",
        hookId: "workflow-hook",
        required: true,
        type: "hook.start",
        workflowId: "runtime-bridge",
      },
    ],
    expectedWrites: [],
    name: "ignores workflow hooks without a node id",
  },
  {
    events: [
      {
        nodeId: "writer",
        sessionId: "ses_writer",
        type: "node.session",
      },
    ],
    expectedWrites: [{ nodeId: "writer", sessionId: "ses_writer", type: "node.session" }],
    name: "projects node.session to node session write intent",
  },
];

describe("projectRuntimeEvent", () => {
  it.each(projectionCases)("$name", ({ events, expectedObservedNodeStatuses, expectedWrites, initialState }) => {
    const projection = projectEvents(events, initialState);

    expect(projection.writes).toEqual(expectedWrites);
    expect([...projection.state.activeHookPreviousStatuses.entries()]).toEqual([]);
    expect([...projection.state.observedNodeStatuses.entries()]).toEqual(expectedObservedNodeStatuses ?? []);
  });

  it("returns next state without mutating the input state", () => {
    const initialState = stateWithObservedStatus("hooked", "passed");

    const projection = projectRuntimeEvent(hookStart, initialState);

    expect([...initialState.activeHookPreviousStatuses.entries()]).toEqual([]);
    expect([...initialState.observedNodeStatuses.entries()]).toEqual([["hooked", "passed"]]);
    expect([...projection.state.activeHookPreviousStatuses.entries()]).toEqual([["notify-hooked", "passed"]]);
    expect([...projection.state.observedNodeStatuses.entries()]).toEqual([["hooked", "running"]]);
    expect(projection.writes).toEqual([{ nodeId: "hooked", status: "running", type: "node.status" }]);
  });
});
