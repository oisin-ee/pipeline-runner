import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildRunnerCommandPayload } from "../runner-command-contract";
import {
  commitAndPushNodeRef,
  mergeDependencyRefs,
  prepareRunnerGitWorkspace,
  promoteFinalRef,
  runnerGitRefs,
} from "./git-refs";

const tempDirs: string[] = [];
const COMMITTER = { email: "git@oisin.ee", name: "oisin-bot" };
const SHA_RE = /^[0-9a-f]{40}$/;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
  delete process.env.PIPELINE_GIT_CREDENTIAL_STORE;
  delete process.env.PIPELINE_WRITABLE_GIT_CREDENTIAL_STORE;
});

describe("runner Git refs", () => {
  it("pushes node refs, merges dependencies, and promotes the final ref", async () => {
    const fixture = tempDir("pipeline-git-refs-");
    const remotePath = join(fixture, "remote.git");
    const seedPath = join(fixture, "seed");
    const leftPath = join(fixture, "left");
    const rightPath = join(fixture, "right");
    const finalPath = join(fixture, "final");
    const checkPath = join(fixture, "check");
    const remoteUrl = seedRemote(fixture, remotePath, seedPath);

    const payload = buildRunnerCommandPayload({
      events: {
        authHeader: "Authorization",
        authTokenFile: "/etc/pipeline/event-auth/token",
        url: "https://console.example/api/pipeline/runner-events",
      },
      repository: {
        baseBranch: "main",
        url: remoteUrl,
      },
      run: {
        id: "run-git-refs",
        project: "project-git-refs",
      },
      task: {
        kind: "prompt",
        prompt: "Verify Git ref state",
      },
      workflow: {
        id: "workflow-git-refs",
      },
    });

    expect(runnerGitRefs(payload, "left")).toEqual({
      finalRef: "refs/heads/pipeline/runs/run-git-refs/workflow-git-refs/final",
      nodeRef:
        "refs/heads/pipeline/runs/run-git-refs/workflow-git-refs/nodes/left",
      prefix: "refs/heads/pipeline/runs/run-git-refs/workflow-git-refs",
    });

    await prepareRunnerGitWorkspace(payload, { workspacePath: leftPath });
    configureGit(leftPath);
    writeFileSync(join(leftPath, "left.txt"), "left\n");
    const leftSha = await commitAndPushNodeRef({
      committer: COMMITTER,
      nodeId: "left",
      payload,
      worktreePath: leftPath,
    });

    await prepareRunnerGitWorkspace(payload, { workspacePath: rightPath });
    await mergeDependencyRefs({
      committer: COMMITTER,
      dependencyNodeIds: ["left"],
      payload,
      worktreePath: rightPath,
    });
    expect(readFileSync(join(rightPath, "left.txt"), "utf8")).toBe("left\n");
    writeFileSync(join(rightPath, "right.txt"), "right\n");
    const rightSha = await commitAndPushNodeRef({
      committer: COMMITTER,
      nodeId: "right",
      payload,
      worktreePath: rightPath,
    });

    await prepareRunnerGitWorkspace(payload, { workspacePath: finalPath });
    const finalSha = await promoteFinalRef({
      committer: COMMITTER,
      payload,
      sourceNodeIds: ["left", "right"],
      worktreePath: finalPath,
    });

    git(fixture, "clone", remoteUrl, checkPath);
    git(checkPath, "fetch", "origin", runnerGitRefs(payload, "final").finalRef);
    git(checkPath, "checkout", "FETCH_HEAD");

    expect(leftSha).toMatch(SHA_RE);
    expect(rightSha).toMatch(SHA_RE);
    expect(finalSha).toMatch(SHA_RE);
    expect(readFileSync(join(checkPath, "left.txt"), "utf8")).toBe("left\n");
    expect(readFileSync(join(checkPath, "right.txt"), "utf8")).toBe("right\n");
  });

  it("copies mounted git credentials to a writable store for runner git commands", async () => {
    const fixture = tempDir("pipeline-git-credentials-");
    const remotePath = join(fixture, "remote.git");
    const seedPath = join(fixture, "seed");
    const worktreePath = join(fixture, "worktree");
    const sourcePath = join(fixture, "mounted-git-credentials");
    const writablePath = join(fixture, "writable-git-credentials");
    writeFileSync(sourcePath, "https://token@example.com\n");
    process.env.PIPELINE_GIT_CREDENTIAL_STORE = sourcePath;
    process.env.PIPELINE_WRITABLE_GIT_CREDENTIAL_STORE = writablePath;
    const remoteUrl = seedRemote(fixture, remotePath, seedPath);

    await prepareRunnerGitWorkspace(
      buildRunnerCommandPayload({
        events: {
          authHeader: "Authorization",
          authTokenFile: "/etc/pipeline/event-auth/token",
          url: "https://console.example/api/pipeline/runner-events",
        },
        repository: {
          baseBranch: "main",
          url: remoteUrl,
        },
        run: {
          id: "run-git-credentials",
          project: "project-git-credentials",
        },
        task: {
          kind: "prompt",
          prompt: "Verify Git credential state",
        },
        workflow: {
          id: "workflow-git-credentials",
        },
      }),
      { workspacePath: worktreePath }
    );

    expect(readFileSync(writablePath, "utf8")).toBe(
      "https://token@example.com\n"
    );
  });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function configureGit(cwd: string): void {
  git(cwd, "config", "user.name", COMMITTER.name);
  git(cwd, "config", "user.email", COMMITTER.email);
}

function seedRemote(
  fixture: string,
  remotePath: string,
  seedPath: string
): string {
  const remoteUrl = pathToFileURL(remotePath).href;
  git(fixture, "init", "--bare", "--initial-branch=main", remotePath);
  git(fixture, "clone", remoteUrl, seedPath);
  configureGit(seedPath);
  writeFileSync(join(seedPath, "README.md"), "seed\n");
  git(seedPath, "add", "README.md");
  git(seedPath, "commit", "-m", "seed");
  git(seedPath, "push", "origin", "main");
  return remoteUrl;
}

function git(cwd: string, ...args: string[]): string {
  mkdirSync(cwd, { recursive: true });
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
