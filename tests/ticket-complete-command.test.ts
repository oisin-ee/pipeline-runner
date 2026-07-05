import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TicketCommandOptions } from "../src/commands/ticket-command";
import { BacklogService } from "../src/runtime/services/backlog-service";

const tempDirs: string[] = [];
const ORIGINAL_PIPELINE_TARGET_PATH = process.env.PIPELINE_TARGET_PATH;
const ORIGINAL_EXIT_CODE = process.exitCode;
let logSpy: ReturnType<typeof vi.spyOn> | undefined;

interface BacklogCall {
  readonly args: readonly string[];
  readonly cwd: string;
}

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = ORIGINAL_EXIT_CODE;
  if (ORIGINAL_PIPELINE_TARGET_PATH === undefined) {
    delete process.env.PIPELINE_TARGET_PATH;
  } else {
    process.env.PIPELINE_TARGET_PATH = ORIGINAL_PIPELINE_TARGET_PATH;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const writeTicket = (
  root: string,
  input: { acceptanceCriteria: readonly string[]; id: string; title: string }
): string => {
  mkdirSync(join(root, "backlog", "tasks"), { recursive: true });
  const acceptanceBlock =
    input.acceptanceCriteria.length > 0
      ? [
          "## Acceptance Criteria",
          "<!-- AC:BEGIN -->",
          ...input.acceptanceCriteria.map(
            (text, index) => `- [ ] #${index + 1} ${text}`
          ),
          "<!-- AC:END -->",
        ]
      : [];
  const path = join(root, "backlog", "tasks", `${input.id}.md`);
  writeFileSync(
    path,
    [
      "---",
      `id: ${input.id}`,
      `title: ${input.title}`,
      "status: In Progress",
      "---",
      "",
      "## Description",
      "<!-- SECTION:DESCRIPTION:BEGIN -->",
      `${input.title} description.`,
      "<!-- SECTION:DESCRIPTION:END -->",
      "",
      ...acceptanceBlock,
      "",
    ].join("\n")
  );
  return path;
};

const recordingBacklogLayer = (
  calls: BacklogCall[]
): NonNullable<TicketCommandOptions["backlogLayer"]> =>
  Layer.succeed(BacklogService, {
    run: (args, cwd) =>
      Effect.sync(() => {
        calls.push({ args: [...args], cwd });
        return `Task ${args[2] ?? ""}`;
      }),
  });

const runComplete = async (
  root: string,
  args: readonly string[],
  backlogLayer: NonNullable<TicketCommandOptions["backlogLayer"]>
): Promise<void> => {
  process.env.PIPELINE_TARGET_PATH = root;
  const { createCliProgram } = await import("../src/cli/program");
  await createCliProgram({ ticketCommand: { backlogLayer } }).parseAsync(
    ["node", "/repo/node_modules/.bin/moka", "ticket", "complete", ...args],
    { from: "node" }
  );
};

const loggedOutput = (): string => {
  if (!logSpy) {
    throw new Error("console.log spy was not initialized");
  }
  return logSpy.mock.calls.map(([line]) => String(line)).join("\n");
};

describe("moka ticket complete", () => {
  it("refuses with a structured unmet list, nonzero exit, and unchanged status", async () => {
    const root = mkdtempSync(join(tmpdir(), "moka-ticket-complete-"));
    tempDirs.push(root);
    const path = writeTicket(root, {
      acceptanceCriteria: ["Refusal path is proven."],
      id: "PIPE-1",
      title: "Refusable",
    });
    const before = readFileSync(path, "utf-8");
    const calls: BacklogCall[] = [];

    await runComplete(
      root,
      ["PIPE-1", "--evidence", "1=looks done to me"],
      recordingBacklogLayer(calls)
    );

    const output = loggedOutput();
    expect(output).toContain("PIPE-1 NOT completed");
    expect(output).toContain("[1]");
    expect(process.exitCode).toBe(1);
    // Status write never happened: no backlog calls, markdown unchanged.
    expect(calls).toEqual([]);
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  it("sets Done through the backlog store on an adjudicator pass and exits zero", async () => {
    const root = mkdtempSync(join(tmpdir(), "moka-ticket-complete-"));
    tempDirs.push(root);
    const path = writeTicket(root, {
      acceptanceCriteria: [],
      id: "PIPE-2",
      title: "Passable",
    });
    const before = readFileSync(path, "utf-8");
    const calls: BacklogCall[] = [];

    await runComplete(root, ["PIPE-2"], recordingBacklogLayer(calls));

    expect(loggedOutput()).toContain("PIPE-2 completed");
    expect(process.exitCode).toBeFalsy();
    expect(calls).toEqual([
      {
        args: ["task", "edit", "PIPE-2", "--status", "Done", "--plain"],
        cwd: root,
      },
    ]);
    // The status write goes through the backlog CLI seam, not a markdown hand-edit.
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  it("emits machine-readable refusal output with --json", async () => {
    const root = mkdtempSync(join(tmpdir(), "moka-ticket-complete-"));
    tempDirs.push(root);
    writeTicket(root, {
      acceptanceCriteria: ["Structured json refusal."],
      id: "PIPE-3",
      title: "Json",
    });

    await runComplete(
      root,
      ["PIPE-3", "--evidence", "1=evidence", "--json"],
      recordingBacklogLayer([])
    );

    const parsed: unknown = JSON.parse(loggedOutput());
    expect(parsed).toMatchObject({
      status: "refused",
      ticketId: "PIPE-3",
      unmet: [{ criterion: "1" }],
    });
    expect(process.exitCode).toBe(1);
  });
});
