import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { PipelineConfig } from "../config";
import type { MokaSubmitInput, MokaSubmitResult } from "../moka-submit";
import type { RunnerEventRecord } from "../runner-command-contract";
import type { BacklogTaskRecord } from "../tickets/backlog-task-store";
import {
  buildControllerDeps,
  type LoopControllerContext,
} from "./controller-deps";
import type { GhRunner, PrResolution } from "./gh-checks";

// ---------------------------------------------------------------------------
// Fixtures — a context with every external boundary stubbed so no test touches
// GitHub / k8s / git. `config` is only consumed by the real submitMoka path,
// which every test replaces with an injected seam, so it is never read here.
// ---------------------------------------------------------------------------

const UNUSED_CONFIG = {} as PipelineConfig; // quality-gate:allow test fixture: config is never read because every test injects the submit seam

function context(
  overrides: Partial<LoopControllerContext> = {}
): LoopControllerContext {
  return {
    baseBranch: "main",
    brokerAuth: {
      secretKey: "api-key",
      secretName: "broker-api-key",
      url: "https://cliproxy.momokaya.ee",
    },
    config: UNUSED_CONFIG,
    eventAuthToken: "loop-token",
    eventUrl: "https://console.example/api/pipeline/runner-events",
    gitCredentialsSecretName: "git-creds",
    maxMergePolls: 5,
    maxRemediationAttempts: 2,
    namespace: "moka",
    project: "demo",
    runId: "loop-run-1",
    strategy: "priority",
    url: "https://github.com/o/r.git",
    worktreePath: "/work",
    ...overrides,
  };
}

const FOUND_PR: Extract<PrResolution, { found: true }> = {
  found: true,
  headRefName: "moka/run/run-A",
  number: 42,
  url: "https://github.com/o/r/pull/42",
};

function submitResult(workflowName: string): MokaSubmitResult {
  return {
    namespace: "moka",
    payloadConfigMapName: "p",
    scheduleConfigMapName: "s",
    taskDescriptorConfigMapName: "t",
    workflowName,
  };
}

/** A gh runner whose json returns queued responses; records every json call. */
function scriptedGh(responses: Record<string, unknown>): {
  gh: GhRunner;
  jsonArgs: string[][];
} {
  const jsonArgs: string[][] = [];
  const gh: GhRunner = {
    json: (args) => {
      jsonArgs.push([...args]);
      const key = args.join(" ");
      const match = Object.entries(responses).find(([prefix]) =>
        key.startsWith(prefix)
      );
      return match
        ? Effect.succeed(match[1])
        : Effect.fail(new Error(`no scripted json for ${key}`));
    },
    text: () => Effect.succeed(""),
  };
  return { gh, jsonArgs };
}

// ---------------------------------------------------------------------------
// AC4 — remediation forwards update-existing-pr + sha + headBranch to submitMoka.
// ---------------------------------------------------------------------------

describe("buildControllerDeps — submitRun forwarding", () => {
  it("forwards update-existing-pr, repository.sha, and headBranch into submitMoka", async () => {
    const submits: MokaSubmitInput[] = [];
    const deps = buildControllerDeps(context(), {
      submitMoka: (input) => {
        submits.push(input);
        return Promise.resolve(submitResult("moka-loop-child-xyz"));
      },
      generateRunId: () => "child-1",
    });

    const result = await Effect.runPromise(
      deps.submitRun({
        ticketId: "PIPE-1",
        deliveryMode: "update-existing-pr",
        repositorySha: "moka/run/run-A",
        headBranch: "moka/run/run-A",
      })
    );

    expect(result).toEqual({
      runId: "child-1",
      workflowName: "moka-loop-child-xyz",
    });
    expect(submits).toHaveLength(1);
    const submit = submits[0];
    expect(submit.delivery).toEqual({
      mode: "update-existing-pr",
      pullRequest: true,
    });
    expect(submit.repository).toEqual({
      baseBranch: "main",
      headBranch: "moka/run/run-A",
      sha: "moka/run/run-A",
      url: "https://github.com/o/r.git",
    });
    expect(submit.run).toEqual({ id: "child-1", project: "demo" });
  });

  it("omits sha/headBranch on the initial create-new-pr submit", async () => {
    const submits: MokaSubmitInput[] = [];
    const deps = buildControllerDeps(context(), {
      submitMoka: (input) => {
        submits.push(input);
        return Promise.resolve(submitResult("wf"));
      },
      generateRunId: () => "child-2",
    });

    await Effect.runPromise(
      deps.submitRun({ ticketId: "PIPE-2", deliveryMode: "create-new-pr" })
    );

    expect(submits[0]?.delivery).toEqual({
      mode: "create-new-pr",
      pullRequest: true,
    });
    expect(submits[0]?.repository).toEqual({
      baseBranch: "main",
      url: "https://github.com/o/r.git",
    });
  });
});

// ---------------------------------------------------------------------------
// classifyChecks — MERGED short-circuits to "merged"; else required checks.
// ---------------------------------------------------------------------------

describe("buildControllerDeps — classifyChecks widening", () => {
  it("returns merged when the PR state is MERGED (no checks call)", async () => {
    const { gh, jsonArgs } = scriptedGh({ "pr view 42": { state: "MERGED" } });
    const deps = buildControllerDeps(context(), { gh });

    const signal = await Effect.runPromise(deps.classifyChecks(FOUND_PR, gh));

    expect(signal).toBe("merged");
    // Only the pr view call — no `pr checks` follow-up once merged.
    expect(jsonArgs.map((a) => a.join(" "))).toEqual([
      "pr view 42 --json state",
    ]);
  });

  it("falls through to classifyRequiredChecks when not merged", async () => {
    const { gh } = scriptedGh({
      "pr view 42": { state: "OPEN" },
      "pr checks 42": {
        checkRuns: [
          {
            conclusion: "failure",
            name: "ci",
            required: true,
            status: "completed",
          },
        ],
        statuses: [],
      },
    });
    const deps = buildControllerDeps(context(), { gh });

    const signal = await Effect.runPromise(deps.classifyChecks(FOUND_PR, gh));

    expect(signal).toBe("fixable");
  });
});

// ---------------------------------------------------------------------------
// emit — monotonic sequence, runId envelope, loop.* record mapping.
// ---------------------------------------------------------------------------

describe("buildControllerDeps — emit envelope and mapping", () => {
  it("wraps each event with runId + monotonic sequence and maps the record", async () => {
    const posted: RunnerEventRecord[] = [];
    const deps = buildControllerDeps(context(), {
      postEvent: (record) => {
        posted.push(record);
        return Promise.resolve();
      },
    });

    await Effect.runPromise(deps.emit({ type: "loop.start", strategy: "bfs" }));
    await Effect.runPromise(
      deps.emit({
        type: "loop.node.transition",
        ticketId: "PIPE-1",
        loopState: "running",
      })
    );
    await Effect.runPromise(
      deps.emit({ type: "loop.finish", passed: 1, blocked: 0 })
    );

    expect(posted.map((r) => r.sequence)).toEqual([1, 2, 3]);
    expect(posted.every((r) => r.runId === "loop-run-1")).toBe(true);

    const [start, transition, finish] = posted;
    expect(start.type).toBe("loop.start");
    if (start.type === "loop.start") {
      expect(start.loopStart).toEqual({ strategy: "bfs" });
    }
    if (transition.type === "loop.node.transition") {
      expect(transition.loopNodeTransition).toEqual({
        loopState: "running",
        ticketId: "PIPE-1",
      });
    }
    if (finish.type === "loop.finish") {
      expect(finish.loopFinish).toEqual({ blocked: 0, passed: 1 });
    }
  });

  it("maps a graph snapshot through the DTO schema", async () => {
    const posted: RunnerEventRecord[] = [];
    const deps = buildControllerDeps(context(), {
      postEvent: (record) => {
        posted.push(record);
        return Promise.resolve();
      },
    });

    const snapshot = {
      batches: [["PIPE-1"]],
      dangling: [],
      edges: [],
      nodes: [
        { id: "PIPE-1", loopState: "queued", status: "To Do", title: "One" },
      ],
    };
    await Effect.runPromise(
      deps.emit({ type: "loop.graph.snapshot", snapshot })
    );

    const record = posted[0];
    expect(record.type).toBe("loop.graph.snapshot");
    if (record.type === "loop.graph.snapshot") {
      expect(record.loopGraphSnapshot.nodes[0]?.id).toBe("PIPE-1");
    }
  });
});

// ---------------------------------------------------------------------------
// refreshBacklog — git refresh runs before the reload.
// ---------------------------------------------------------------------------

describe("buildControllerDeps — refreshBacklog", () => {
  it("git-refreshes then reloads the backlog records", async () => {
    const calls: string[] = [];
    const tasks: readonly BacklogTaskRecord[] = [
      {
        acceptanceCriteria: [],
        dependencies: [],
        filePath: "backlog/tasks/A.md",
        id: "A",
        modifiedFiles: [],
        references: [],
        status: "To Do",
        title: "A",
      },
    ];
    const deps = buildControllerDeps(context(), {
      gitRefresh: (path) => {
        calls.push(`git:${path}`);
        return Promise.resolve();
      },
      loadTasks: (path) => {
        calls.push(`load:${path}`);
        return Effect.succeed(tasks);
      },
    });

    const reloaded = await Effect.runPromise(deps.refreshBacklog());

    expect(reloaded).toEqual(tasks);
    // git refresh happens BEFORE the reload.
    expect(calls).toEqual(["git:/work", "load:/work"]);
  });
});
