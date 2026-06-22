import { describe, expect, it } from "vitest";
import {
  parseRunnerCommandPayload,
  runnerCommandPayloadSchema,
  runnerDeliverySchema,
  runnerRepositoryContextSchema,
} from "./runner-command-contract";

// ---------------------------------------------------------------------------
// AC1: runner payload parses update-existing-pr delivery + repository.headBranch
// ---------------------------------------------------------------------------

const BASE_PAYLOAD = {
  delivery: {
    mode: "update-existing-pr",
    pullRequest: true,
  },
  events: {
    authTokenFile: "/etc/token",
    url: "https://events.example.com",
  },
  repository: {
    baseBranch: "main",
    headBranch: "moka/run/run-x",
    url: "git@github.com:owner/repo.git",
  },
  run: {
    id: "run-x",
    project: "owner/repo",
    requestedBy: "oisin",
  },
  task: {
    kind: "prompt",
    prompt: "Fix CI failures",
  },
  workflow: {
    id: "default",
  },
};

describe("runnerDeliverySchema", () => {
  it("parses update-existing-pr mode", () => {
    const result = runnerDeliverySchema.parse({
      mode: "update-existing-pr",
      pullRequest: true,
    });
    expect(result.mode).toBe("update-existing-pr");
    expect(result.pullRequest).toBe(true);
  });

  it("defaults mode to create-new-pr when absent", () => {
    const result = runnerDeliverySchema.parse({ pullRequest: false });
    expect(result.mode).toBe("create-new-pr");
  });
});

describe("runnerRepositoryContextSchema", () => {
  it("parses headBranch when provided", () => {
    const result = runnerRepositoryContextSchema.parse({
      baseBranch: "main",
      headBranch: "moka/run/run-x",
      url: "git@github.com:owner/repo.git",
    });
    expect(result.headBranch).toBe("moka/run/run-x");
  });

  it("headBranch is optional", () => {
    const result = runnerRepositoryContextSchema.parse({
      baseBranch: "main",
      url: "git@github.com:owner/repo.git",
    });
    expect(result.headBranch).toBeUndefined();
  });
});

describe("runnerCommandPayloadSchema — AC1", () => {
  it("parses full payload with update-existing-pr delivery and repository.headBranch", () => {
    const result = runnerCommandPayloadSchema.safeParse(BASE_PAYLOAD);
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.delivery.mode).toBe("update-existing-pr");
    expect(result.data.delivery.pullRequest).toBe(true);
    expect(result.data.repository.headBranch).toBe("moka/run/run-x");
  });

  it("parseRunnerCommandPayload accepts update-existing-pr payload string", () => {
    const payload = parseRunnerCommandPayload(JSON.stringify(BASE_PAYLOAD));
    expect(payload.delivery.mode).toBe("update-existing-pr");
    expect(payload.repository.headBranch).toBe("moka/run/run-x");
  });

  it("fresh-PR payload (no mode, no headBranch) parses unchanged", () => {
    const freshPayload = {
      ...BASE_PAYLOAD,
      delivery: { pullRequest: true },
      repository: { baseBranch: "main", url: "git@github.com:owner/repo.git" },
    };
    const result = runnerCommandPayloadSchema.safeParse(freshPayload);
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.delivery.mode).toBe("create-new-pr");
    expect(result.data.repository.headBranch).toBeUndefined();
  });
});
