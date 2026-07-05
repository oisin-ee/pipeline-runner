import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  commitAndPushNodeRef,
  prepareRunnerGitWorkspace,
} from "../src/run-state/git-refs";
import type { RunnerCommandPayload } from "../src/runner-command-contract";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const createFakeGitFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-git-refs-"));
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const logPath = join(dir, "git-calls.jsonl");
  writeFileSync(logPath, "");
  const gitPath = join(bin, "git");
  writeFileSync(
    gitPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PIPELINE_FAKE_GIT_LOG, JSON.stringify({
  args,
  cwd: process.cwd(),
  env: {
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND,
    GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT,
  },
}) + "\\n");
if (args.includes("clone")) {
  fs.mkdirSync(path.resolve(args.at(-1)), { recursive: true });
}
if (args[0] === "remote" && args[1] === "get-url") {
  console.log(process.env.PIPELINE_FAKE_REMOTE_URL || "https://github.com/oisin-ee/pipeline-runner.git");
}
if (args[0] === "rev-parse") {
  console.log("fedcba9876543210fedcba9876543210fedcba98");
}
`,
    { mode: 0o755 }
  );
  chmodSync(gitPath, 0o755);
  return { bin, dir, logPath };
};

const createSshCredentialFixture = () => {
  const fixture = createFakeGitFixture();
  const credentialsDir = join(fixture.dir, "credentials");
  mkdirSync(credentialsDir, { recursive: true });
  writeFileSync(join(credentialsDir, "identity"), "private-key\n");
  writeFileSync(
    join(credentialsDir, "known_hosts"),
    "github.com ssh-ed25519 AAAA\n"
  );
  process.env.PATH = `${fixture.bin}:${ORIGINAL_ENV.PATH ?? ""}`;
  process.env.PIPELINE_FAKE_GIT_LOG = fixture.logPath;
  process.env.PIPELINE_GIT_CREDENTIALS_DIR = credentialsDir;
  process.env.PIPELINE_WRITABLE_GIT_CREDENTIAL_STORE = join(
    fixture.dir,
    "writable",
    "git-credentials"
  );
  return fixture;
};

const readFakeGitCalls = (
  logPath: string
): {
  args: string[];
  cwd: string;
  env: { GIT_SSH_COMMAND?: string; GIT_TERMINAL_PROMPT?: string };
}[] => {
  const content = readFileSync(logPath, "utf-8").trim();
  if (!content) {
    return [];
  }
  return content.split("\n").map((line) => JSON.parse(line));
};

const payloadWithRemote = (url: string): RunnerCommandPayload => ({
  contractVersion: "1",
  delivery: { mode: "create-new-pr", pullRequest: false },
  events: {
    authHeader: "Authorization",
    authTokenFile: "/etc/pipeline/event-auth/token",
    url: "https://console.example.test/events",
  },
  repository: {
    baseBranch: "main",
    sha: "0123456789abcdef0123456789abcdef01234567",
    url,
  },
  run: { id: "run-test", project: "pipeline-runner" },
  submission: { kind: "graph", mode: "quick" },
  task: { kind: "prompt", prompt: "test" },
  workflow: { id: "schedule-test-root" },
});

describe("runner git workspace preparation", () => {
  it("rejects SSH remotes when mounted git credentials only contain basic auth", async () => {
    const fixture = createFakeGitFixture();
    const credentialsDir = join(fixture.dir, "credentials");
    mkdirSync(credentialsDir, { recursive: true });
    writeFileSync(join(credentialsDir, "username"), "oisin-bot\n");
    writeFileSync(join(credentialsDir, "password"), "github-token\n");
    process.env.PATH = `${fixture.bin}:${ORIGINAL_ENV.PATH ?? ""}`;
    process.env.PIPELINE_FAKE_GIT_LOG = fixture.logPath;
    process.env.PIPELINE_GIT_CREDENTIALS_DIR = credentialsDir;
    process.env.PIPELINE_WRITABLE_GIT_CREDENTIAL_STORE = join(
      fixture.dir,
      "writable",
      "git-credentials"
    );
    mkdirSync(join(fixture.dir, "workspace"), { recursive: true });

    await expect(
      prepareRunnerGitWorkspace(
        payloadWithRemote("git@github.com:oisin-ee/pipeline-runner.git"),
        { workspacePath: join(fixture.dir, "workspace") }
      )
    ).rejects.toThrow(
      "SSH git remote git@github.com:oisin-ee/pipeline-runner.git requires mounted git credential file(s): identity, known_hosts"
    );

    expect(readFakeGitCalls(fixture.logPath)).toEqual([]);
  });

  it("uses strict SSH options when SSH git credentials are mounted", async () => {
    const fixture = createSshCredentialFixture();

    await prepareRunnerGitWorkspace(
      payloadWithRemote("git@github.com:oisin-ee/pipeline-runner.git"),
      { workspacePath: join(fixture.dir, "workspace") }
    );

    const calls = readFakeGitCalls(fixture.logPath);
    const clone = calls.find((call) => call.args.includes("clone"));
    expect(clone?.args).toContain(
      "git@github.com:oisin-ee/pipeline-runner.git"
    );
    expect(clone?.env.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=yes");
    expect(clone?.env.GIT_SSH_COMMAND).toContain("UserKnownHostsFile=");
  });

  it("uses strict SSH options for origin alias pushes after clone", async () => {
    const fixture = createSshCredentialFixture();
    const payload = payloadWithRemote(
      "git@github.com:oisin-ee/pipeline-runner.git"
    );
    process.env.PIPELINE_FAKE_REMOTE_URL = payload.repository.url;
    const worktreePath = join(fixture.dir, "workspace");

    await prepareRunnerGitWorkspace(payload, { workspacePath: worktreePath });
    await commitAndPushNodeRef({
      committer: { email: "pipeline@example.test", name: "Pipeline" },
      nodeId: "backlog-intake",
      payload,
      worktreePath,
    });

    const calls = readFakeGitCalls(fixture.logPath);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ args: ["remote", "get-url", "origin"] }),
      ])
    );
    const lsRemote = calls.find((call) => call.args[0] === "ls-remote");
    expect(lsRemote?.args).toEqual([
      "ls-remote",
      "--heads",
      "origin",
      "refs/heads/pipeline/runs/run-test/schedule-test-root/nodes/backlog-intake",
    ]);
    expect(lsRemote?.env.GIT_SSH_COMMAND).toContain(
      "StrictHostKeyChecking=yes"
    );
    expect(lsRemote?.env.GIT_SSH_COMMAND).toContain("UserKnownHostsFile=");
    const push = calls.find((call) => call.args[0] === "push");
    expect(push?.args).toEqual([
      "push",
      "--force-with-lease=refs/heads/pipeline/runs/run-test/schedule-test-root/nodes/backlog-intake:",
      "origin",
      "HEAD:refs/heads/pipeline/runs/run-test/schedule-test-root/nodes/backlog-intake",
    ]);
    expect(push?.env.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=yes");
    expect(push?.env.GIT_SSH_COMMAND).toContain("UserKnownHostsFile=");
  });

  it("rejects origin alias pushes for SSH origins before invoking network git", async () => {
    const fixture = createFakeGitFixture();
    const credentialsDir = join(fixture.dir, "credentials");
    mkdirSync(credentialsDir, { recursive: true });
    writeFileSync(join(credentialsDir, "username"), "oisin-bot\n");
    writeFileSync(join(credentialsDir, "password"), "github-token\n");
    process.env.PATH = `${fixture.bin}:${ORIGINAL_ENV.PATH ?? ""}`;
    process.env.PIPELINE_FAKE_GIT_LOG = fixture.logPath;
    process.env.PIPELINE_FAKE_REMOTE_URL =
      "git@github.com:oisin-ee/pipeline-runner.git";
    process.env.PIPELINE_GIT_CREDENTIALS_DIR = credentialsDir;
    process.env.PIPELINE_WRITABLE_GIT_CREDENTIAL_STORE = join(
      fixture.dir,
      "writable",
      "git-credentials"
    );
    mkdirSync(join(fixture.dir, "workspace"), { recursive: true });

    await expect(
      commitAndPushNodeRef({
        committer: { email: "pipeline@example.test", name: "Pipeline" },
        nodeId: "backlog-intake",
        payload: payloadWithRemote(
          "https://github.com/oisin-ee/pipeline-runner.git"
        ),
        worktreePath: join(fixture.dir, "workspace"),
      })
    ).rejects.toThrow(
      "SSH git remote git@github.com:oisin-ee/pipeline-runner.git requires mounted git credential file(s): identity, known_hosts"
    );

    const calls = readFakeGitCalls(fixture.logPath);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ args: ["remote", "get-url", "origin"] }),
      ])
    );
    expect(calls).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ args: expect.arrayContaining(["push"]) }),
      ])
    );
  });
});
