import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { PipelineConfig } from "../config";
import type { MokaSubmitInput, MokaSubmitResult } from "../moka-submit";
import type { BacklogTaskRecord } from "../tickets/backlog-task-store";
import { loopControllerArgv, parseLoopFlags, runLoopSubmit } from "./loop-command";
import type { LoopSubmitInput } from "./loop-command";

const UNUSED_CONFIG = {} as PipelineConfig; // quality-gate:allow test fixture: config flows untouched through the injected submit seam

const STRATEGY_ERROR = /--strategy/u;
const MERGE_TIMEOUT_ERROR = /--merge-timeout/u;
const CYCLE_ERROR = /cycle/iu;
const NO_READY_TICKET_ERROR = /no ready ticket/u;

const task = (
  id: string,
  dependencies: readonly string[] = [],
  status: BacklogTaskRecord["status"] = "To Do",
): BacklogTaskRecord => ({
  acceptanceCriteria: [],
  dependencies,
  filePath: `backlog/tasks/${id}.md`,
  id,
  modifiedFiles: [],
  references: [],
  status,
  title: id,
});

/** A ticket parented under an epic so root-scoped selection can reach it. */
const child = (id: string, parentTaskId: string): BacklogTaskRecord => ({
  ...task(id),
  parentTaskId,
});

const submitResult = (workflowName: string): MokaSubmitResult => ({
  namespace: "moka",
  payloadConfigMapName: "p",
  scheduleConfigMapName: "s",
  taskDescriptorConfigMapName: "t",
  workflowName,
});

const submitInput = (flags: LoopSubmitInput["flags"], overrides: Partial<LoopSubmitInput> = {}): LoopSubmitInput => ({
  brokerAuth: {
    secretKey: "api-key",
    secretName: "broker-api-key",
    url: "https://cliproxy.momokaya.ee",
  },
  config: UNUSED_CONFIG,
  eventUrl: "https://console/api/pipeline/runner-events",
  flags,
  gitCredentialsSecretName: "git-creds",
  namespace: "moka",
  worktreePath: "/work",
  ...overrides,
});

/** A submit seam that records inputs and flips a flag when called. */
const recordingSubmit = (
  workflowName: string,
): {
  submit: (input: MokaSubmitInput) => Promise<MokaSubmitResult>;
  submits: MokaSubmitInput[];
} => {
  const submits: MokaSubmitInput[] = [];
  return {
    submit: async (input) => {
      submits.push(input);
      return await Promise.resolve(submitResult(workflowName));
    },
    submits,
  };
};

// ---------------------------------------------------------------------------
// Flag parsing.
// ---------------------------------------------------------------------------

describe("parseLoopFlags", () => {
  it("defaults strategy to priority and leaves bounds undefined", () => {
    expect(parseLoopFlags({})).toEqual({
      maxMergePolls: undefined,
      maxRemediationAttempts: undefined,
      rootId: undefined,
      strategy: "priority",
    });
  });

  it("parses all flags", () => {
    expect(
      parseLoopFlags({
        maxRemediationAttempts: "3",
        mergeTimeout: "30",
        root: "PIPE-88",
        strategy: "dfs",
      }),
    ).toEqual({
      maxMergePolls: 30,
      maxRemediationAttempts: 3,
      rootId: "PIPE-88",
      strategy: "dfs",
    });
  });

  it("rejects an unknown strategy", () => {
    expect(() => parseLoopFlags({ strategy: "random" })).toThrow(STRATEGY_ERROR);
  });

  it("rejects a non-positive bound", () => {
    expect(() => parseLoopFlags({ mergeTimeout: "0" })).toThrow(MERGE_TIMEOUT_ERROR);
  });
});

// ---------------------------------------------------------------------------
// AC2 — flags forward into the controller argv.
// ---------------------------------------------------------------------------

describe("loopControllerArgv — AC2 flag forwarding", () => {
  it("forwards strategy/root/max-remediation/merge-timeout to the controller", () => {
    const argv = loopControllerArgv({
      maxMergePolls: 30,
      maxRemediationAttempts: 3,
      rootId: "PIPE-88",
      strategy: "dfs",
    });
    expect(argv).toEqual([
      "moka",
      "loop-controller",
      "--strategy",
      "dfs",
      "--root",
      "PIPE-88",
      "--max-remediation-attempts",
      "3",
      "--merge-timeout",
      "30",
    ]);
  });

  it("omits absent optional flags", () => {
    expect(loopControllerArgv({ strategy: "priority" })).toEqual(["moka", "loop-controller", "--strategy", "priority"]);
  });
});

// ---------------------------------------------------------------------------
// AC1 — runLoopSubmit submits a command workflow with the controller entrypoint.
// ---------------------------------------------------------------------------

describe("runLoopSubmit — AC1 cloud submission", () => {
  it("submits the controller as a command workflow and returns its name", async () => {
    const { submit, submits } = recordingSubmit("moka-loop-abc");
    const result = await runLoopSubmit(
      submitInput({
        maxMergePolls: 25,
        maxRemediationAttempts: 4,
        rootId: "PIPE-88",
        strategy: "bfs",
      }),
      {
        // Epic PIPE-88 with one ready child so the --root scope has work.
        loadTasks: () => Effect.succeed([task("PIPE-88"), child("PIPE-88.1", "PIPE-88")]),
        submitMoka: submit,
      },
    );

    expect(result.workflowName).toBe("moka-loop-abc");
    expect(submits).toHaveLength(1);
    const submit0 = submits[0];
    expect(submit0.type).toBe("command");
    if (submit0.type === "command") {
      expect(submit0.commandArgv).toEqual([
        "moka",
        "loop-controller",
        "--strategy",
        "bfs",
        "--root",
        "PIPE-88",
        "--max-remediation-attempts",
        "4",
        "--merge-timeout",
        "25",
      ]);
    }
    expect(submit0.namespace).toBe("moka");
    expect(submit0.eventUrl).toBe("https://console/api/pipeline/runner-events");
  });
});

// ---------------------------------------------------------------------------
// AC5 — cyclic / empty backlog refuses to start (rejects, with a message).
// ---------------------------------------------------------------------------

describe("runLoopSubmit — AC5 refuses unstartable backlog", () => {
  it("refuses a cyclic backlog and never submits", async () => {
    const { submit, submits } = recordingSubmit("never");
    await expect(
      runLoopSubmit(submitInput({ strategy: "bfs" }), {
        loadTasks: () => Effect.succeed([task("A", ["B"]), task("B", ["A"])]),
        submitMoka: submit,
      }),
    ).rejects.toThrow(CYCLE_ERROR);
    expect(submits).toHaveLength(0);
  });

  it("refuses an empty backlog and never submits", async () => {
    const { submit, submits } = recordingSubmit("never");
    await expect(
      runLoopSubmit(submitInput({ strategy: "priority" }), {
        loadTasks: () => Effect.succeed([]),
        submitMoka: submit,
      }),
    ).rejects.toThrow(NO_READY_TICKET_ERROR);
    expect(submits).toHaveLength(0);
  });

  it("refuses a fully-resolved backlog with no ready ticket", async () => {
    const { submit, submits } = recordingSubmit("never");
    await expect(
      runLoopSubmit(submitInput({ strategy: "priority" }), {
        loadTasks: () => Effect.succeed([task("A", [], "Done"), task("B", ["A"], "Done")]),
        submitMoka: submit,
      }),
    ).rejects.toThrow(NO_READY_TICKET_ERROR);
    expect(submits).toHaveLength(0);
  });
});
