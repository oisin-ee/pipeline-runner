import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { parsePipelineConfigParts } from "../../config";
import { compileWorkflowPlan } from "../../planning/compile";
import type {
  NodeAttemptResult,
  PipelineRuntimeEvent,
  RuntimeContext,
} from "../contracts";
import { NodeStateStore } from "../node-state-store";
import { CommandExecutor } from "../services/command-executor-service";
import type { OpenPullRequestGitClient } from "../services/open-pull-request-git-service";
import { OpenPullRequestGitService } from "../services/open-pull-request-git-service";
import { openPullRequestProgram } from "./open-pull-request";

// ---------------------------------------------------------------------------
// Fake git client builder
// ---------------------------------------------------------------------------

interface FakeGitOptions {
  cleanTree?: boolean;
  defaultBranch?: string;
  symbolicRefFails?: boolean;
}

type GitEffect = Effect.Effect<string, unknown>;

const fakeSymbolicRef = (
  opts: FakeGitOptions,
  defaultBranch: string
): GitEffect => {
  if (opts.symbolicRefFails === true) {
    return Effect.fail(new Error("no symbolic ref"));
  }
  return Effect.succeed(`origin/${defaultBranch}`);
};

const fakeStatusPorcelain = (cleanTree: boolean): GitEffect =>
  Effect.succeed(cleanTree ? "" : "M file.ts");

const fakeGitRawSimple = (args: string[], cmd: string): GitEffect => {
  if (args[0] === "checkout" && args[1] === "-B") {
    return Effect.succeed("");
  }
  if (args[0] === "config" || args[0] === "commit" || args[0] === "push") {
    return Effect.succeed("");
  }
  if (cmd === "add -A") {
    return Effect.succeed("");
  }
  return Effect.fail(new Error(`unexpected git command: ${cmd}`));
};

const fakeGitRaw = (
  args: string[],
  opts: FakeGitOptions,
  defaultBranch: string,
  cleanTree: boolean
): GitEffect => {
  const cmd = args.join(" ");
  if (cmd === "symbolic-ref --short refs/remotes/origin/HEAD") {
    return fakeSymbolicRef(opts, defaultBranch);
  }
  if (cmd === "status --porcelain") {
    return fakeStatusPorcelain(cleanTree);
  }
  if (cmd === "rev-parse --abbrev-ref HEAD") {
    return Effect.succeed(defaultBranch);
  }
  return fakeGitRawSimple(args, cmd);
};

const buildFakeGitClient = (
  opts: FakeGitOptions = {}
): OpenPullRequestGitClient => {
  const defaultBranch = opts.defaultBranch ?? "main";
  const cleanTree = opts.cleanTree ?? true;
  return {
    raw: (args: string[]) => fakeGitRaw(args, opts, defaultBranch, cleanTree),
  };
};

// ---------------------------------------------------------------------------
// Recorded calls tracker
// ---------------------------------------------------------------------------

interface RecordedCall {
  args: string[];
}

const buildRecordingCommandExecutor = (
  exitCode = 0,
  output = "https://github.com/owner/repo/pull/1",
  existingPrOutput = ""
): {
  layer: Layer.Layer<CommandExecutor>;
  calls: RecordedCall[];
} => {
  const calls: RecordedCall[] = [];
  const layer = Layer.succeed(CommandExecutor, {
    execute: (command: string[]) => {
      calls.push({ args: command });
      const isCreate = command.includes("create");
      const isEdit = command.includes("edit");
      if (isCreate && exitCode !== 0) {
        return Effect.succeed<NodeAttemptResult>({
          evidence: [],
          exitCode,
          output: existingPrOutput || output,
        });
      }
      if (isEdit) {
        return Effect.succeed<NodeAttemptResult>({
          evidence: [],
          exitCode: 0,
          output: "preview",
        });
      }
      if (command.includes("view")) {
        return Effect.succeed<NodeAttemptResult>({
          evidence: [],
          exitCode: 0,
          output,
        });
      }
      return Effect.succeed<NodeAttemptResult>({
        evidence: [],
        exitCode: 0,
        output,
      });
    },
  });
  return { calls, layer };
};

// ---------------------------------------------------------------------------
// Context factory
// ---------------------------------------------------------------------------

const contextForOpenPr = (
  task = "Fix bug\n\nMore detail",
  headBranch?: string,
  mode?: "create-new-pr" | "update-existing-pr",
  reporter?: RuntimeContext["reporter"]
): RuntimeContext => {
  const config = parsePipelineConfigParts({
    pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: a
workflows:
  default:
    nodes:
      - id: pr
        kind: builtin
        builtin: open-pull-request
`,
    profiles: `
version: 1
profiles:
  a:
    runner: opencode
    instructions: { inline: A }
`,
    runners: `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      output_formats: [text]
`,
  });
  const configWithDelivery: typeof config =
    headBranch !== undefined || mode !== undefined
      ? {
          ...config,
          delivery: {
            pull_request: {
              enabled: true,
              head_branch: headBranch,
              label: "preview",
              mode: mode ?? "create-new-pr",
            },
          },
        }
      : config;
  return {
    agentInvocations: [],
    config: configWithDelivery,
    executor: () => ({ exitCode: 0, stdout: "" }),
    gates: [],
    hookFailures: [],
    hookPolicy: {
      allowCommandHooks: true,
      allowUntrustedCommandHooks: true,
      env: {},
      envPassthrough: ["PATH"],
      outputLimitBytes: 1024,
      timeoutMs: 1000,
    },
    hookResults: new Map(),
    nodeStateStore: new NodeStateStore(),
    plan: compileWorkflowPlan(config),
    ...(reporter ? { reporter } : {}),
    runId: "run-opr",
    task,
    workflowId: "default",
    worktreePath: process.cwd(),
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const buildFakeGitLayer = (
  opts: FakeGitOptions = {}
): Layer.Layer<OpenPullRequestGitService> => {
  const client = buildFakeGitClient(opts);
  return Layer.succeed(OpenPullRequestGitService, {
    create: (_baseDir) => Effect.succeed(client),
  });
};

const runWithLayers = async (
  context: RuntimeContext,
  gitLayer: Layer.Layer<OpenPullRequestGitService>,
  executorLayer: Layer.Layer<CommandExecutor>
): Promise<NodeAttemptResult> => {
  const merged = Layer.merge(gitLayer, executorLayer);
  return await Effect.runPromise(
    Effect.provide(openPullRequestProgram(context), merged)
  );
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("open-pull-request builtin", () => {
  it("pushes the head branch and opens a PR with the resolved base and head", async () => {
    const context = contextForOpenPr();
    const { calls, layer: executorLayer } = buildRecordingCommandExecutor();
    const gitLayer = buildFakeGitLayer();

    const result = await runWithLayers(context, gitLayer, executorLayer);

    expect(result.exitCode).toBe(0);

    const createCall = calls.find(
      (c) => c.args.includes("create") && c.args.includes("pr")
    );
    expect(createCall).toBeDefined();
    expect(createCall?.args).toContain("--base");
    expect(createCall?.args).toContain("main");
    expect(createCall?.args).toContain("--head");
    expect(createCall?.args).toContain("moka/run/run-opr");
    expect(createCall?.args).not.toContain("--label");
    expect(result.evidence[0]).toContain("opened");

    const editCall = calls.find(
      (c) => c.args.includes("edit") && c.args.includes("pr")
    );
    expect(editCall).toBeDefined();
    expect(editCall?.args).toContain("--add-label");
    expect(editCall?.args).toContain("preview");
  });

  it("emits a typed delivery event when a PR is opened", async () => {
    const events: PipelineRuntimeEvent[] = [];
    const context = contextForOpenPr(
      "Fix bug",
      undefined,
      undefined,
      (event) => {
        events.push(event);
      }
    );
    const { layer: executorLayer } = buildRecordingCommandExecutor();
    const gitLayer = buildFakeGitLayer();

    const result = await runWithLayers(context, gitLayer, executorLayer);

    expect(result.exitCode).toBe(0);
    expect(events).toContainEqual({
      deliveryPullRequest: {
        action: "opened",
        url: "https://github.com/owner/repo/pull/1",
      },
      type: "delivery.pull-request",
    });
  });

  it("emits a typed delivery event when an existing PR is updated", async () => {
    const events: PipelineRuntimeEvent[] = [];
    const context = contextForOpenPr(
      "Fix bug",
      undefined,
      "update-existing-pr",
      (event) => {
        events.push(event);
      }
    );
    const { layer: executorLayer } = buildRecordingCommandExecutor();
    const gitLayer = buildFakeGitLayer();

    const result = await runWithLayers(context, gitLayer, executorLayer);

    expect(result.exitCode).toBe(0);
    expect(events).toContainEqual({
      deliveryPullRequest: {
        action: "updated",
        url: "https://github.com/owner/repo/pull/1",
      },
      type: "delivery.pull-request",
    });
  });

  it("still reports the PR as opened when the label doesn't exist on the target repo", async () => {
    const context = contextForOpenPr();
    const calls: RecordedCall[] = [];
    const executorLayer = Layer.succeed(CommandExecutor, {
      execute: (command: string[]) => {
        calls.push({ args: command });
        if (command.includes("create")) {
          return Effect.succeed<NodeAttemptResult>({
            evidence: [],
            exitCode: 0,
            output: "https://github.com/owner/repo/pull/1",
          });
        }
        return Effect.succeed<NodeAttemptResult>({
          evidence: [],
          exitCode: 1,
          output: "could not add label: 'preview' not found",
        });
      },
    });
    const gitLayer = buildFakeGitLayer();

    const result = await runWithLayers(context, gitLayer, executorLayer);

    expect(result.exitCode).toBe(0);
    expect(result.evidence[0]).toContain("opened");
    expect(result.evidence.some((line) => line.includes("not applied"))).toBe(
      true
    );
  });

  it("falls back to gh pr edit when the PR already exists", async () => {
    const context = contextForOpenPr();
    const { calls, layer: executorLayer } = buildRecordingCommandExecutor(
      1,
      "",
      "already exists"
    );
    const gitLayer = buildFakeGitLayer();

    const result = await runWithLayers(context, gitLayer, executorLayer);

    expect(result.exitCode).toBe(0);
    const editCall = calls.find(
      (c) => c.args.includes("edit") && c.args.includes("pr")
    );
    expect(editCall).toBeDefined();
    expect(editCall?.args).toContain("--add-label");
    expect(editCall?.args).toContain("preview");
    expect(result.evidence[0]).toContain("updated");
  });

  it("returns success without error for a clean working tree", async () => {
    const context = contextForOpenPr();
    const { layer: executorLayer } = buildRecordingCommandExecutor();
    const gitLayer = buildFakeGitLayer({ cleanTree: true });

    const result = await runWithLayers(context, gitLayer, executorLayer);

    expect(result.exitCode).toBe(0);
    expect(result.evidence[0]).toContain("opened");
  });

  it("falls back to current branch when symbolic-ref fails", async () => {
    const context = contextForOpenPr();
    const { calls, layer: executorLayer } = buildRecordingCommandExecutor();
    const gitLayer = buildFakeGitLayer({ symbolicRefFails: true });

    const result = await runWithLayers(context, gitLayer, executorLayer);

    expect(result.exitCode).toBe(0);
    const createCall = calls.find(
      (c) => c.args.includes("create") && c.args.includes("pr")
    );
    expect(createCall).toBeDefined();
    expect(createCall?.args).toContain("--base");
  });

  it("uses the first line of the task as the PR title", async () => {
    const context = contextForOpenPr("Add feature X\n\nThis implements X.");
    const { calls, layer: executorLayer } = buildRecordingCommandExecutor();
    const gitLayer = buildFakeGitLayer();

    await runWithLayers(context, gitLayer, executorLayer);

    const createCall = calls.find(
      (c) => c.args.includes("create") && c.args.includes("pr")
    );
    const titleIdx = createCall?.args.indexOf("--title") ?? -1;
    expect(createCall?.args[titleIdx + 1]).toBe("Add feature X");
  });

  it("returns exitCode 1 and evidence on git failure", async () => {
    const context = contextForOpenPr();
    const failGitLayer = Layer.succeed(OpenPullRequestGitService, {
      create: (_baseDir) =>
        Effect.succeed({
          raw: (_args: string[]) =>
            Effect.fail(new Error("git: repository not found")),
        }),
    });
    const { layer: executorLayer } = buildRecordingCommandExecutor();

    const result = await runWithLayers(context, failGitLayer, executorLayer);

    expect(result.exitCode).toBe(1);
    expect(result.evidence[0]).toContain("open-pull-request failed");
  });

  // AC2: update-existing-pr mode — appends fix-commits to the provided PR branch
  // (workspace is already that branch) and updates the existing PR, no gh pr create
  it("update-existing-pr mode: pushes to provided head branch and skips pr create", async () => {
    const context = contextForOpenPr(
      "Fix CI",
      "moka/run/run-x",
      "update-existing-pr"
    );
    const { calls, layer: executorLayer } = buildRecordingCommandExecutor();

    const gitCalls: string[][] = [];
    const gitLayer = Layer.succeed(OpenPullRequestGitService, {
      create: (_baseDir) =>
        Effect.succeed({
          raw: (args: string[]) => {
            gitCalls.push([...args]);
            const cmd = args.join(" ");
            if (cmd === "symbolic-ref --short refs/remotes/origin/HEAD") {
              return Effect.succeed("origin/main");
            }
            if (cmd === "status --porcelain") {
              return Effect.succeed("");
            }
            if (
              args[0] === "fetch" ||
              args[0] === "checkout" ||
              args[0] === "config" ||
              args[0] === "push"
            ) {
              return Effect.succeed("");
            }
            if (cmd === "add -A") {
              return Effect.succeed("");
            }
            return Effect.fail(new Error(`unexpected git command: ${cmd}`));
          },
        }),
    });

    const result = await runWithLayers(context, gitLayer, executorLayer);

    expect(result.exitCode).toBe(0);
    // no fetch: basing is owned by the workspace (controller sets repository.sha
    // to the PR head), not this builtin; `checkout -B` would discard a fetch
    const fetchCall = gitCalls.find((args) => args[0] === "fetch");
    expect(fetchCall).toBeUndefined();
    // checkout uses the provided head branch
    const checkoutCall = gitCalls.find(
      (args) => args[0] === "checkout" && args[1] === "-B"
    );
    expect(checkoutCall).toContain("moka/run/run-x");
    // push targets the provided PR branch (append fix-commits)
    const pushCall = gitCalls.find((args) => args[0] === "push");
    expect(pushCall).toBeDefined();
    expect(pushCall?.join(" ")).toContain("moka/run/run-x");
    // no gh pr create
    const createCall = calls.find(
      (c) => c.args.includes("create") && c.args.includes("pr")
    );
    expect(createCall).toBeUndefined();
    // gh pr edit called directly
    const editCall = calls.find(
      (c) => c.args.includes("edit") && c.args.includes("pr")
    );
    expect(editCall).toBeDefined();
    expect(result.evidence[0]).toContain("updated");
  });

  // AC3: fresh-PR path unchanged when mode absent — existing test coverage already proves this;
  // adding explicit assertion that create IS called when no mode set
  it("create-new-pr mode (explicit): calls gh pr create and not edit directly", async () => {
    const context = contextForOpenPr("Add feature", undefined, "create-new-pr");
    const { calls, layer: executorLayer } = buildRecordingCommandExecutor();
    const gitLayer = buildFakeGitLayer();

    const result = await runWithLayers(context, gitLayer, executorLayer);

    expect(result.exitCode).toBe(0);
    const createCall = calls.find(
      (c) => c.args.includes("create") && c.args.includes("pr")
    );
    expect(createCall).toBeDefined();
    expect(result.evidence[0]).toContain("opened");
  });
});
