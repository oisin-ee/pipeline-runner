import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  runnerCommitMessage,
} from "./git-refs";

const tempDirs: string[] = [];
const COMMITTER = { email: "git@oisin.ee", name: "oisin-bot" };
const SHA_RE = /^[0-9a-f]{40}$/u;
// Mirrors the Conventional Commits subject that a target repo's commit-msg hook
// (e.g. jalgpall-web's `conventional-commits` lefthook) enforces.
const CONVENTIONAL_SUBJECT_RE = /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\(.+\))?!?: .+/u;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
  delete process.env.PIPELINE_GIT_CREDENTIALS_DIR;
  delete process.env.PIPELINE_WRITABLE_GIT_CREDENTIAL_STORE;
  delete process.env.GIT_CONFIG_COUNT;
  delete process.env.GIT_CONFIG_KEY_0;
  delete process.env.GIT_CONFIG_VALUE_0;
});

const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const git = (cwd: string, ...args: string[]): string => {
  mkdirSync(cwd, { recursive: true });
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
};

const configureGit = (cwd: string): void => {
  git(cwd, "config", "user.name", COMMITTER.name);
  git(cwd, "config", "user.email", COMMITTER.email);
};

const seedRemote = (fixture: string, remotePath: string, seedPath: string): string => {
  const remoteUrl = pathToFileURL(remotePath).href;
  git(fixture, "init", "--bare", "--initial-branch=main", remotePath);
  git(fixture, "clone", remoteUrl, seedPath);
  configureGit(seedPath);
  writeFileSync(join(seedPath, "README.md"), "seed\n");
  git(seedPath, "add", "README.md");
  git(seedPath, "commit", "-m", "seed");
  git(seedPath, "push", "origin", "main");
  return remoteUrl;
};

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

    const finalRef = "refs/heads/pipeline/runs/run-git-refs/workflow-git-refs/final";

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
    expect(readFileSync(join(rightPath, "left.txt"), "utf-8")).toBe("left\n");
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
    git(checkPath, "fetch", "origin", finalRef);
    git(checkPath, "checkout", "FETCH_HEAD");

    expect(leftSha).toMatch(SHA_RE);
    expect(rightSha).toMatch(SHA_RE);
    expect(finalSha).toMatch(SHA_RE);
    expect(readFileSync(join(checkPath, "left.txt"), "utf-8")).toBe("left\n");
    expect(readFileSync(join(checkPath, "right.txt"), "utf-8")).toBe("right\n");

    // Every checkpoint subject on the promoted branch must satisfy a target
    // repo's Conventional Commits commit-msg hook (the bare `pipeline: <node>`
    // form was rejected with exit 1 by jalgpall-web's hook).
    const subjects = git(checkPath, "log", "--format=%s").trim().split("\n");
    const checkpointSubjects = subjects.filter((subject) => subject.startsWith("chore(pipeline):"));
    expect(checkpointSubjects).toContain(runnerCommitMessage("right"));
    for (const subject of checkpointSubjects) {
      expect(subject).toMatch(CONVENTIONAL_SUBJECT_RE);
    }
  });

  it("replaces a prior attempt's generated node ref when the same node is retried", async () => {
    const fixture = tempDir("pipeline-git-retry-ref-");
    const remotePath = join(fixture, "remote.git");
    const seedPath = join(fixture, "seed");
    const firstAttemptPath = join(fixture, "first-attempt");
    const secondAttemptPath = join(fixture, "second-attempt");
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
        id: "run-git-retry-ref",
        project: "project-git-retry-ref",
      },
      task: {
        kind: "prompt",
        prompt: "Verify Git retry ref state",
      },
      workflow: {
        id: "workflow-git-retry-ref",
      },
    });
    const retriedNodeRef = "refs/heads/pipeline/runs/run-git-retry-ref/workflow-git-retry-ref/nodes/red-tests";

    await prepareRunnerGitWorkspace(payload, {
      workspacePath: firstAttemptPath,
    });
    writeFileSync(join(firstAttemptPath, "failed-attempt.txt"), "failed\n");
    await commitAndPushNodeRef({
      committer: COMMITTER,
      nodeId: "red-tests",
      payload,
      worktreePath: firstAttemptPath,
    });

    await prepareRunnerGitWorkspace(payload, {
      workspacePath: secondAttemptPath,
    });
    writeFileSync(join(secondAttemptPath, "passed-attempt.txt"), "passed\n");
    await commitAndPushNodeRef({
      committer: COMMITTER,
      nodeId: "red-tests",
      payload,
      worktreePath: secondAttemptPath,
    });

    git(fixture, "clone", remoteUrl, checkPath);
    git(checkPath, "fetch", "origin", retriedNodeRef);
    git(checkPath, "checkout", "FETCH_HEAD");

    expect(readFileSync(join(checkPath, "passed-attempt.txt"), "utf-8")).toBe("passed\n");
    expect(() => readFileSync(join(checkPath, "failed-attempt.txt"), "utf-8")).toThrow();
  });

  it("writes mounted username and password credentials to a writable store for runner git commands", async () => {
    const fixture = tempDir("pipeline-git-credentials-");
    const remotePath = join(fixture, "remote.git");
    const seedPath = join(fixture, "seed");
    const worktreePath = join(fixture, "worktree");
    const credentialsDir = join(fixture, "mounted-git-credentials");
    const writablePath = join(fixture, "writable-git-credentials");
    mkdirSync(credentialsDir, { recursive: true });
    writeFileSync(join(credentialsDir, "username"), "x-access-token\n");
    writeFileSync(join(credentialsDir, "password"), "token value\n");
    process.env.PIPELINE_GIT_CREDENTIALS_DIR = credentialsDir;
    process.env.PIPELINE_WRITABLE_GIT_CREDENTIAL_STORE = writablePath;
    const remoteUrl = seedRemote(fixture, remotePath, seedPath);
    const authenticatedRemoteUrl = "https://example.test/oisin/pipeline.git";
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = `url.${remoteUrl}.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = authenticatedRemoteUrl;

    await prepareRunnerGitWorkspace(
      buildRunnerCommandPayload({
        events: {
          authHeader: "Authorization",
          authTokenFile: "/etc/pipeline/event-auth/token",
          url: "https://console.example/api/pipeline/runner-events",
        },
        repository: {
          baseBranch: "main",
          url: authenticatedRemoteUrl,
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
      { workspacePath: worktreePath },
    );

    expect(readFileSync(writablePath, "utf-8")).toBe("https://x-access-token:token%20value@example.test\n");
  });
});
