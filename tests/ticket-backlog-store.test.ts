import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Exit } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { RepoIoServiceLive } from "../src/runtime/services/repo-io-service";
import { loadBacklogTaskStoreEffect } from "../src/tickets/backlog-task-store";

const DUPLICATE_ID_RE =
  /Duplicate Backlog task id PIPE-41\.7.*pipe-41\.7 - (?:Duplicate|One)\.md.*pipe-41\.7 - (?:Duplicate|One)\.md/su;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const makeBacklog = (): string => {
  const root = mkdtempSync(join(tmpdir(), "moka-ticket-store-"));
  tempDirs.push(root);
  mkdirSync(join(root, "backlog", "tasks"), { recursive: true });
  return root;
};

const writeTask = (root: string, filename: string, source: string): string => {
  const path = join(root, "backlog", "tasks", filename);
  writeFileSync(path, source);
  return path;
};

const loadStore = async (root: string) =>
  await Effect.runPromise(
    Effect.provide(loadBacklogTaskStoreEffect(root), RepoIoServiceLive)
  );

const loadStoreExit = async (root: string) =>
  await Effect.runPromiseExit(
    Effect.provide(loadBacklogTaskStoreEffect(root), RepoIoServiceLive)
  );

describe("Backlog task store", () => {
  it("loads typed task records through the repository IO boundary", async () => {
    const root = makeBacklog();
    const filePath = writeTask(
      root,
      "pipe-84.1 - Task.md",
      [
        "---",
        "id: PIPE-84.1",
        "title: Build reusable Backlog task store",
        "status: To Do",
        "priority: high",
        "ordinal: 234000",
        "parent_task_id: PIPE-84",
        "dependencies:",
        "  - PIPE-12",
        "references:",
        "  - src/schedule/backlog-context.ts",
        "modified_files:",
        "  - src/tickets/backlog-task-store.ts",
        "---",
        "",
        "## Description",
        "<!-- SECTION:DESCRIPTION:BEGIN -->",
        "Create a reusable read-only task store.",
        "<!-- SECTION:DESCRIPTION:END -->",
        "",
        "## Acceptance Criteria",
        "<!-- AC:BEGIN -->",
        "- [ ] #1 Parses task markdown; evidence: focused test.",
        "- [x] #2 Preserves status markers; evidence: focused test.",
        "<!-- AC:END -->",
        "",
      ].join("\n")
    );
    const before = readFileSync(filePath, "utf-8");

    const store = await loadStore(root);

    expect(store.tasks).toHaveLength(1);
    expect(store.tasks[0]).toEqual({
      acceptanceCriteria: [
        "Parses task markdown; evidence: focused test.",
        "Preserves status markers; evidence: focused test.",
      ],
      dependencies: ["PIPE-12"],
      description: "Create a reusable read-only task store.",
      filePath,
      id: "PIPE-84.1",
      modifiedFiles: ["src/tickets/backlog-task-store.ts"],
      ordinal: 234_000,
      parentTaskId: "PIPE-84",
      priority: "high",
      references: ["src/schedule/backlog-context.ts"],
      status: "To Do",
      title: "Build reusable Backlog task store",
    });
    expect(store.tasksById.get("PIPE-84.1")).toBe(store.tasks[0]);
    expect(readFileSync(filePath, "utf-8")).toBe(before);
  });

  it("keeps expected parse failures in the Effect error channel", async () => {
    const root = makeBacklog();
    writeTask(
      root,
      "pipe-1 - Bad.md",
      "---\nid: PIPE-1\nstatus: Invalid\n---\n"
    );

    const exit = await loadStoreExit(root);

    if (!Exit.isFailure(exit)) {
      throw new Error("Expected task markdown parsing to fail");
    }
    const failure = String(exit.cause);
    expect(failure).toContain("pipe-1 - Bad.md");
    expect(failure).toContain("title: Invalid input");
    expect(failure).toContain("status: Invalid option");
  });

  it("reports duplicate dotted task ids with both file paths", async () => {
    const root = makeBacklog();
    writeTask(
      root,
      "pipe-41.7 - One.md",
      "---\nid: PIPE-41.7\ntitle: One\nstatus: To Do\n---\n"
    );
    writeTask(
      root,
      "pipe-41.7 - Duplicate.md",
      "---\nid: PIPE-41.7\ntitle: Duplicate\nstatus: To Do\n---\n"
    );

    await expect(loadStore(root)).rejects.toThrow(DUPLICATE_ID_RE);
  });
});
