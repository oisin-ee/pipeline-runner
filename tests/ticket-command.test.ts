import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CliProgramOptions } from "../src/cli/program";
import type { RunCommandCall } from "../src/cli/run-command";
import type { TicketCommandOptions } from "../src/commands/ticket-command";
import type { AgentResult, RunnerLaunchPlan } from "../src/runner";
import { BacklogService } from "../src/runtime/services/backlog-service";

const tempDirs: string[] = [];
const ORIGINAL_PIPELINE_TARGET_PATH = process.env.PIPELINE_TARGET_PATH;
const NO_READY_TICKETS_PATTERN = /no ready tickets/iu;
const REMOTE_READ_ONLY_PATTERN = /--read-only.*--target remote/iu;
const BACKLOG_TOOL_PATTERN = /backlog/iu;
const BACKLOG_DIRECTIVE_84_2 = [
  "## Backlog ticket management",
  "",
  'Your first action must be to set this ticket to "In Progress":',
  '  backlog task edit PIPE-84.2 --status "In Progress" --plain',
  "",
  'Your final action on completion must be to set this ticket to "Done" and update ' +
    "its acceptance criteria through the backlog tools:",
  '  backlog task edit PIPE-84.2 --status "Done" --plain',
  "",
  "Use backlog tools on your working branch. Do not hand-edit the task markdown file.",
].join("\n");
const SELECTED_START_TASK = `PIPE-84.2 - Graph\n\nGraph description.\n\n${BACKLOG_DIRECTIVE_84_2}`;
const SELECTED_START_TITLE = "PIPE-84.2 - Graph";
let logSpy: Option.Option<ReturnType<typeof vi.spyOn>> = Option.none();

type ParseTicketCommandOptions = TicketCommandOptions &
  Pick<CliProgramOptions, "runCommand">;

interface BacklogCall {
  readonly args: readonly string[];
  readonly cwd: string;
}

beforeEach(() => {
  logSpy = Option.some(vi.spyOn(console, "log").mockImplementation(() => {}));
});

afterEach(() => {
  vi.restoreAllMocks();
  logSpy = Option.none();
  if (ORIGINAL_PIPELINE_TARGET_PATH === undefined) {
    delete process.env.PIPELINE_TARGET_PATH;
  } else {
    process.env.PIPELINE_TARGET_PATH = ORIGINAL_PIPELINE_TARGET_PATH;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const writeTask = (
  root: string,
  filename: string,
  input: {
    dependencies?: readonly string[];
    id: string;
    parentTaskId?: string;
    status: "Done" | "In Progress" | "To Do";
    title: string;
  }
): string => {
  const path = join(root, "backlog", "tasks", filename);
  writeFileSync(
    path,
    [
      "---",
      `id: ${input.id}`,
      `title: ${input.title}`,
      `status: ${input.status}`,
      input.parentTaskId === undefined
        ? ""
        : `parent_task_id: ${input.parentTaskId}`,
      ...(input.dependencies !== undefined && input.dependencies.length > 0
        ? ["dependencies:", ...input.dependencies.map((id) => `  - ${id}`)]
        : []),
      "---",
      "",
      "## Description",
      "<!-- SECTION:DESCRIPTION:BEGIN -->",
      `${input.title} description.`,
      "<!-- SECTION:DESCRIPTION:END -->",
      "",
      "## Acceptance Criteria",
      "<!-- AC:BEGIN -->",
      "- [ ] #1 Has an acceptance criterion.",
      "<!-- AC:END -->",
      "",
    ]
      .filter((line) => line !== "")
      .join("\n")
  );
  return path;
};

const makeBacklogFixture = (): { root: string; taskFiles: string[] } => {
  const root = mkdtempSync(join(tmpdir(), "moka-ticket-command-"));
  tempDirs.push(root);
  mkdirSync(join(root, "backlog", "tasks"), { recursive: true });
  const taskFiles = [
    writeTask(root, "pipe-84 - Epic.md", {
      id: "PIPE-84",
      status: "To Do",
      title: "Epic",
    }),
    writeTask(root, "pipe-84.1 - Store.md", {
      id: "PIPE-84.1",
      parentTaskId: "PIPE-84",
      status: "Done",
      title: "Store",
    }),
    writeTask(root, "pipe-84.2 - Graph.md", {
      dependencies: ["PIPE-84.1"],
      id: "PIPE-84.2",
      parentTaskId: "PIPE-84",
      status: "To Do",
      title: "Graph",
    }),
  ];
  return { root, taskFiles };
};

const makeDoneBacklogFixture = (): { root: string; taskFiles: string[] } => {
  const root = mkdtempSync(join(tmpdir(), "moka-ticket-command-"));
  tempDirs.push(root);
  mkdirSync(join(root, "backlog", "tasks"), { recursive: true });
  const taskFiles = [
    writeTask(root, "pipe-84 - Epic.md", {
      id: "PIPE-84",
      status: "Done",
      title: "Epic",
    }),
    writeTask(root, "pipe-84.1 - Completed.md", {
      id: "PIPE-84.1",
      parentTaskId: "PIPE-84",
      status: "Done",
      title: "Completed",
    }),
  ];
  return { root, taskFiles };
};

const fileSnapshot = (paths: readonly string[]): Map<string, string> =>
  new Map(paths.map((path) => [path, readFileSync(path, "utf-8")]));

const parseTicketCommandWithOptions = async (
  root: string,
  args: readonly string[],
  options: ParseTicketCommandOptions = {}
) => {
  process.env.PIPELINE_TARGET_PATH = root;
  const { runCommand, ...ticketCommand } = options;
  const { createCliProgram } = await import("../src/cli/program");
  await createCliProgram({ runCommand, ticketCommand }).parseAsync(
    ["node", "/repo/node_modules/.bin/moka", "ticket", ...args],
    { from: "node" }
  );
};

const parseTicketCommand = async (root: string, args: readonly string[]) => {
  await parseTicketCommandWithOptions(root, args);
};

const recordingBacklogLayer = (
  calls: BacklogCall[],
  events?: string[]
): NonNullable<TicketCommandOptions["backlogLayer"]> =>
  Layer.succeed(BacklogService, {
    run: (args, cwd) =>
      Effect.sync(() => {
        events?.push("claim");
        calls.push({ args: [...args], cwd });
        return "Task PIPE-84.2 - Graph";
      }),
  });

const loggedOutput = (): string =>
  Option.match(logSpy, {
    onNone: () => {
      throw new Error("console.log spy was not initialized");
    },
    onSome: (spy) => spy.mock.calls.map(([line]) => String(line)).join("\n"),
  });

describe("moka ticket read-only commands", () => {
  it("registers graph check, sequence, and next help", async () => {
    process.env.PIPELINE_TARGET_PATH = makeBacklogFixture().root;
    const { createCliProgram } = await import("../src/cli/program");
    const ticketCommand = createCliProgram().commands.find(
      (command) => command.name() === "ticket"
    );

    expect(ticketCommand?.helpInformation()).toContain("graph");
    expect(ticketCommand?.helpInformation()).toContain("sequence");
    expect(ticketCommand?.helpInformation()).toContain("next");
    expect(
      ticketCommand?.commands.find((command) => command.name() === "graph")
    ).toBeDefined();
  });

  it("checks graph validity without mutating task markdown", async () => {
    const { root, taskFiles } = makeBacklogFixture();
    const before = fileSnapshot(taskFiles);

    await parseTicketCommand(root, ["graph", "check", "--root", "PIPE-84"]);

    expect(loggedOutput()).toContain("OK: ticket graph valid");
    expect(fileSnapshot(taskFiles)).toEqual(before);
  });

  it("prints stable plain sequence batches without mutating task markdown", async () => {
    const { root, taskFiles } = makeBacklogFixture();
    const before = fileSnapshot(taskFiles);

    await parseTicketCommand(root, [
      "sequence",
      "--root",
      "PIPE-84",
      "--plain",
    ]);

    expect(loggedOutput()).toContain("Sequence 1:\n  PIPE-84\n  PIPE-84.1");
    expect(loggedOutput()).toContain("Sequence 2:\n  PIPE-84.2");
    expect(fileSnapshot(taskFiles)).toEqual(before);
  });

  it("prints the selected next ticket as JSON without mutating task markdown", async () => {
    const { root, taskFiles } = makeBacklogFixture();
    const before = fileSnapshot(taskFiles);

    await parseTicketCommand(root, ["next", "--root", "PIPE-84", "--json"]);

    expect(JSON.parse(loggedOutput())).toMatchObject({
      selected: { id: "PIPE-84.2", status: "To Do" },
    });
    expect(fileSnapshot(taskFiles)).toEqual(before);
  });

  it("claims the deterministic next ready ticket through BacklogService without mutating task markdown", async () => {
    const { root, taskFiles } = makeBacklogFixture();
    const before = fileSnapshot(taskFiles);
    const backlogCalls: { args: readonly string[]; cwd: string }[] = [];
    const backlogLayer = Layer.succeed(BacklogService, {
      run: (args, cwd) =>
        Effect.sync(() => {
          backlogCalls.push({ args: [...args], cwd });
          return "Task PIPE-84.2 - Graph";
        }),
    });

    await parseTicketCommandWithOptions(
      root,
      ["next", "--claim", "--root", "PIPE-84"],
      { backlogLayer }
    );

    expect(backlogCalls).toEqual([
      {
        args: [
          "task",
          "edit",
          "PIPE-84.2",
          "--status",
          "In Progress",
          "--plain",
        ],
        cwd: root,
      },
    ]);
    expect(fileSnapshot(taskFiles)).toEqual(before);
  });

  it("does not call BacklogService when --claim finds no ready tickets", async () => {
    const { root, taskFiles } = makeDoneBacklogFixture();
    const before = fileSnapshot(taskFiles);
    const backlogCalls: { args: readonly string[]; cwd: string }[] = [];
    const backlogLayer = Layer.succeed(BacklogService, {
      run: (args, cwd) =>
        Effect.sync(() => {
          backlogCalls.push({ args: [...args], cwd });
          return "unexpected Backlog mutation";
        }),
    });
    let thrown: unknown;

    try {
      await parseTicketCommandWithOptions(
        root,
        ["next", "--claim", "--root", "PIPE-84"],
        { backlogLayer }
      );
    } catch (error) {
      thrown = error;
    }

    const clearMessage = [
      loggedOutput(),
      thrown instanceof Error ? thrown.message : String(thrown ?? ""),
    ].join("\n");
    expect(clearMessage).toMatch(NO_READY_TICKETS_PATTERN);
    expect(backlogCalls).toEqual([]);
    expect(fileSnapshot(taskFiles)).toEqual(before);
  });

  describe("ticket start", () => {
    it("dry-runs the selected ticket as an exact moka run command without claiming or dispatching", async () => {
      const { root, taskFiles } = makeBacklogFixture();
      const before = fileSnapshot(taskFiles);
      const backlogCalls: BacklogCall[] = [];
      const runCommand = vi.fn(async (_: RunCommandCall) => {});

      await parseTicketCommandWithOptions(
        root,
        [
          "start",
          "--dry-run",
          "--root",
          "PIPE-84",
          "--effort",
          "quick",
          "--target",
          "remote",
        ],
        {
          backlogLayer: recordingBacklogLayer(backlogCalls),
          runCommand,
        }
      );

      expect(loggedOutput()).toContain(
        `Selected ticket: ${SELECTED_START_TITLE}`
      );
      expect(loggedOutput()).toContain(
        `moka run --effort quick --target remote '${SELECTED_START_TASK}'`
      );
      expect(backlogCalls).toEqual([]);
      expect(runCommand).not.toHaveBeenCalled();
      expect(fileSnapshot(taskFiles)).toEqual(before);
    });

    it("claims the selected ticket before dispatching a default local normal write run", async () => {
      const { root, taskFiles } = makeBacklogFixture();
      const before = fileSnapshot(taskFiles);
      const events: string[] = [];
      const backlogCalls: BacklogCall[] = [];
      const runCommand = vi.fn((_: RunCommandCall) => {
        events.push("run");
        return;
      });

      await parseTicketCommandWithOptions(
        root,
        ["start", "--root", "PIPE-84"],
        {
          backlogLayer: recordingBacklogLayer(backlogCalls, events),
          runCommand,
        }
      );

      expect(events).toEqual(["claim", "run"]);
      expect(backlogCalls).toEqual([
        {
          args: [
            "task",
            "edit",
            "PIPE-84.2",
            "--status",
            "In Progress",
            "--plain",
          ],
          cwd: root,
        },
      ]);
      expect(runCommand).toHaveBeenCalledTimes(1);
      const runCall = runCommand.mock.calls[0][0];
      expect(runCall.task).toBe(SELECTED_START_TASK);
      expect(runCall.descriptionParts).toEqual([SELECTED_START_TASK]);
      expect(runCall.descriptionParts.join("\n")).toContain(
        SELECTED_START_TITLE
      );
      expect(runCall.descriptionParts.join("\n")).toContain(
        "Graph description."
      );
      expect(runCall.flags).toMatchObject({
        effort: "normal",
        target: "local",
      });
      expect(runCall.resolution).toMatchObject({
        effort: "normal",
        execution: { kind: "local-runtime" },
        mode: "write",
        target: "local",
      });
      expect(fileSnapshot(taskFiles)).toEqual(before);
    });

    it("threads ticketId as a typed field on the RunCommandCall", async () => {
      const { root } = makeBacklogFixture();
      const backlogCalls: BacklogCall[] = [];
      const runCommand = vi.fn(async (_: RunCommandCall) => {});

      await parseTicketCommandWithOptions(
        root,
        ["start", "--root", "PIPE-84"],
        {
          backlogLayer: recordingBacklogLayer(backlogCalls),
          runCommand,
        }
      );

      const runCall = runCommand.mock.calls[0][0];
      expect(runCall.ticketId).toBe("PIPE-84.2");
    });

    it("includes a backlog status/AC update directive in the agent instruction", async () => {
      const { root } = makeBacklogFixture();
      const backlogCalls: BacklogCall[] = [];
      const runCommand = vi.fn(async (_: RunCommandCall) => {});

      await parseTicketCommandWithOptions(
        root,
        ["start", "--root", "PIPE-84"],
        {
          backlogLayer: recordingBacklogLayer(backlogCalls),
          runCommand,
        }
      );

      const runCall = runCommand.mock.calls[0][0];
      const instruction = runCall.task;
      // must contain the status-update directive language
      expect(instruction).toContain("In Progress");
      expect(instruction).toContain("Done");
      // must reference backlog tooling (not prose-embedded id)
      expect(instruction).toMatch(BACKLOG_TOOL_PATTERN);
    });

    it("reports no ready tickets without claiming, dispatching, or mutating files", async () => {
      const { root, taskFiles } = makeDoneBacklogFixture();
      const before = fileSnapshot(taskFiles);
      const backlogCalls: BacklogCall[] = [];
      const runCommand = vi.fn(async (_: RunCommandCall) => {});
      let thrown: unknown;

      try {
        await parseTicketCommandWithOptions(
          root,
          ["start", "--root", "PIPE-84"],
          {
            backlogLayer: recordingBacklogLayer(backlogCalls),
            runCommand,
          }
        );
      } catch (error) {
        thrown = error;
      }

      const clearMessage = [
        loggedOutput(),
        thrown instanceof Error ? thrown.message : String(thrown ?? ""),
      ].join("\n");
      expect(clearMessage).toMatch(NO_READY_TICKETS_PATTERN);
      expect(backlogCalls).toEqual([]);
      expect(runCommand).not.toHaveBeenCalled();
      expect(fileSnapshot(taskFiles)).toEqual(before);
    });

    it("rejects remote read-only start before claiming or dispatching", async () => {
      const { root, taskFiles } = makeBacklogFixture();
      const before = fileSnapshot(taskFiles);
      const backlogCalls: BacklogCall[] = [];
      const runCommand = vi.fn(async (_: RunCommandCall) => {});
      let thrown: unknown;

      try {
        await parseTicketCommandWithOptions(
          root,
          [
            "start",
            "--dry-run",
            "--root",
            "PIPE-84",
            "--target",
            "remote",
            "--read-only",
          ],
          {
            backlogLayer: recordingBacklogLayer(backlogCalls),
            runCommand,
          }
        );
      } catch (error) {
        thrown = error;
      }

      const clearMessage = [
        loggedOutput(),
        thrown instanceof Error ? thrown.message : String(thrown ?? ""),
      ].join("\n");
      expect(clearMessage).toMatch(REMOTE_READ_ONLY_PATTERN);
      expect(backlogCalls).toEqual([]);
      expect(runCommand).not.toHaveBeenCalled();
      expect(fileSnapshot(taskFiles)).toEqual(before);
    });

    it.each([
      {
        args: ["--effort", "quick"],
        expectedFlags: { effort: "quick", target: "local" },
        expectedResolution: {
          effort: "quick",
          execution: { entrypoint: "quick", kind: "local-runtime" },
          mode: "write",
          target: "local",
        },
        label: "--effort quick",
      },
      {
        args: ["--effort", "thorough"],
        expectedFlags: { effort: "thorough", target: "local" },
        expectedResolution: {
          effort: "thorough",
          execution: { entrypoint: "execute", kind: "local-runtime" },
          mode: "write",
          target: "local",
        },
        label: "--effort thorough",
      },
      {
        args: ["--target", "remote"],
        expectedFlags: { effort: "normal", target: "remote" },
        expectedResolution: {
          effort: "normal",
          execution: { kind: "remote-submit", mode: "full" },
          mode: "write",
          target: "remote",
        },
        label: "--target remote",
      },
      {
        args: ["--read-only"],
        expectedFlags: { effort: "normal", readOnly: true, target: "local" },
        expectedResolution: {
          effort: "normal",
          execution: { kind: "local-runtime", workflow: "inspect" },
          mode: "read",
          target: "local",
        },
        label: "--read-only",
      },
    ])("passes $label through shared run resolution", async (testCase) => {
      const { root, taskFiles } = makeBacklogFixture();
      const before = fileSnapshot(taskFiles);
      const backlogCalls: BacklogCall[] = [];
      const runCommand = vi.fn(async (_: RunCommandCall) => {});

      await parseTicketCommandWithOptions(
        root,
        ["start", "--root", "PIPE-84", ...testCase.args],
        {
          backlogLayer: recordingBacklogLayer(backlogCalls),
          runCommand,
        }
      );

      expect(backlogCalls).toHaveLength(1);
      expect(backlogCalls[0]?.args).toEqual([
        "task",
        "edit",
        "PIPE-84.2",
        "--status",
        "In Progress",
        "--plain",
      ]);
      expect(runCommand).toHaveBeenCalledTimes(1);
      const runCall = runCommand.mock.calls[0][0];
      expect(runCall.task).toBe(SELECTED_START_TASK);
      expect(runCall.flags).toMatchObject(testCase.expectedFlags);
      expect(runCall.resolution).toMatchObject(testCase.expectedResolution);
      expect(fileSnapshot(taskFiles)).toEqual(before);
    });
  });

  it("renders ticket create dry-run output from a validated scoper result without mutating Backlog", async () => {
    const { root, taskFiles } = makeBacklogFixture();
    const before = fileSnapshot(taskFiles);
    let launchPlan = Option.none<RunnerLaunchPlan>();
    const ticketPlanExecutor = async (
      plan: RunnerLaunchPlan
    ): Promise<AgentResult> => {
      launchPlan = Option.some(plan);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          epic: {
            acceptance_criteria: [
              {
                evidence: "CLI test asserts rendered output.",
                text: "Dry-run renders command output.",
              },
            ],
            description: "Create the epic.",
            key: "epic",
            plan: "Plan the epic.",
            priority: "high",
            references: ["defaults/profiles.yaml"],
            title: "Epic: Create tickets",
          },
          tickets: [
            {
              acceptance_criteria: [
                {
                  evidence: "CLI test checks --dep schema.",
                  text: "Dry-run includes dependency flags.",
                },
              ],
              depends_on: ["schema"],
              description: "Render commands.",
              key: "render",
              likely_files: ["src/tickets/ticket-plan-render.ts"],
              plan: "Render commands.",
              priority: "medium",
              title: "Render commands",
            },
            {
              acceptance_criteria: [
                {
                  evidence: "CLI test validates schema output.",
                  text: "Plan validates structured output.",
                },
              ],
              description: "Validate schema.",
              key: "schema",
              likely_files: ["src/tickets/ticket-plan.ts"],
              plan: "Validate schema.",
              priority: "high",
              title: "Validate schema",
            },
          ],
        }),
      };
    };

    await parseTicketCommandWithOptions(
      root,
      ["create", "add", "ticket", "dry-run", "--dry-run"],
      { ticketPlanExecutor }
    );

    const plan = Option.getOrThrowWith(
      launchPlan,
      () => new Error("Expected ticket create dry-run launch plan")
    );
    expect(plan.profileId).toBe("moka-ticket-scoper");
    expect(plan.outputFormat).toBe("json_schema");
    expect(plan.args.join(" ")).toContain("add ticket dry-run");
    expect(plan.args.join(" ")).toContain("acceptance_criteria");
    expect(plan.args.join(" ")).toContain("depends_on");
    expect(plan.args.join(" ")).toContain("Do not use epics");
    expect(loggedOutput()).toMatchInlineSnapshot(`
      "# Dry run: no Backlog files were written.
      backlog task create 'Epic: Create tickets' --description 'Create the epic.' --priority high --ac 'Dry-run renders command output.; evidence: CLI test asserts rendered output.' --plan 'Plan the epic.' --ref defaults/profiles.yaml --plain
      backlog task create 'Render commands' --parent epic --description 'Render commands.' --priority medium --dep schema --ac 'Dry-run includes dependency flags.; evidence: CLI test checks --dep schema.' --plan 'Render commands.' --modified-file src/tickets/ticket-plan-render.ts --plain
      backlog task create 'Validate schema' --parent epic --description 'Validate schema.' --priority high --ac 'Plan validates structured output.; evidence: CLI test validates schema output.' --plan 'Validate schema.' --modified-file src/tickets/ticket-plan.ts --plain"
    `);
    expect(fileSnapshot(taskFiles)).toEqual(before);
  });

  it("applies a validated ticket plan through BacklogService with an existing parent", async () => {
    const { root, taskFiles } = makeBacklogFixture();
    const before = fileSnapshot(taskFiles);
    const backlogCalls: { args: readonly string[]; cwd: string }[] = [];
    const ticketPlanExecutor = async (): Promise<AgentResult> => ({
      exitCode: 0,
      stdout: JSON.stringify({
        tickets: [
          {
            acceptance_criteria: [
              {
                evidence: "CLI apply test records BacklogService args.",
                text: "Apply uses BacklogService.",
              },
            ],
            description: "Apply one child.",
            key: "child",
            plan: "Create one child.",
            title: "Apply one child",
          },
        ],
      }),
    });
    const backlogLayer = Layer.succeed(BacklogService, {
      run: (args, cwd) =>
        Effect.sync(() => {
          backlogCalls.push({ args, cwd });
          return "Task PIPE-84.10 - Apply one child";
        }),
    });

    await parseTicketCommandWithOptions(
      root,
      ["create", "apply", "one", "child", "--apply", "--parent", "PIPE-84"],
      { backlogLayer, ticketPlanExecutor }
    );

    expect(backlogCalls.map((call) => call.args)).toEqual([
      [
        "task",
        "create",
        "Apply one child",
        "--parent",
        "PIPE-84",
        "--description",
        "Apply one child.",
        "--ac",
        "Apply uses BacklogService.; evidence: CLI apply test records BacklogService args.",
        "--plan",
        "Create one child.",
        "--plain",
      ],
    ]);
    expect(loggedOutput()).toContain("Created tickets:");
    expect(loggedOutput()).toContain("child: PIPE-84.10");
    expect(fileSnapshot(taskFiles)).toEqual(before);
  });
});
