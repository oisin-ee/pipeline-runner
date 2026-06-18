import { describe, expect, it } from "vitest";
import { parsePipelineConfigParts } from "../../config";
import type { ScheduleArtifact } from "../../planning/generate";
import { appendPullRequestDelivery } from "./open-pull-request";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseConfig(deliveryEnabled?: boolean, label?: string) {
  const deliveryYaml =
    deliveryEnabled === undefined
      ? ""
      : `delivery:\n  pull_request:\n    enabled: ${deliveryEnabled}${label ? `\n    label: ${label}` : ""}`;
  return parsePipelineConfigParts({
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
    profiles: `
version: 1
profiles:
  a:
    runner: opencode
    instructions: { inline: A }
`,
    pipeline: `
version: 1
default_workflow: root
orchestrator:
  profile: a
${deliveryYaml}
workflows:
  root:
    nodes: []
`,
  });
}

function artifactWithNodes(
  nodes: ScheduleArtifact["workflows"]["root"]["nodes"]
): ScheduleArtifact {
  return {
    generated_at: "2026-06-18T00:00:00.000Z",
    kind: "pipeline-schedule",
    root_workflow: "root",
    schedule_id: "test-run",
    source_entrypoint: "execute",
    task: "test task",
    version: 1,
    workflows: {
      root: { nodes },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("appendPullRequestDelivery pass", () => {
  it("returns artifact unchanged when delivery is disabled (default)", () => {
    const config = baseConfig(false);
    const artifact = artifactWithNodes([
      { id: "impl", kind: "agent", profile: "a" },
    ]);

    const result = appendPullRequestDelivery(config, artifact);

    expect(result).toBe(artifact);
  });

  it("returns artifact unchanged when delivery config is absent", () => {
    const config = baseConfig(undefined);
    const artifact = artifactWithNodes([
      { id: "impl", kind: "agent", profile: "a" },
    ]);

    const result = appendPullRequestDelivery(config, artifact);

    expect(result).toBe(artifact);
  });

  it("appends a single open-pull-request builtin depending on all terminal nodes", () => {
    const config = baseConfig(true);
    const artifact = artifactWithNodes([
      { id: "research", kind: "agent", profile: "a" },
      { id: "implement", kind: "agent", profile: "a", needs: ["research"] },
      { id: "verify", kind: "agent", profile: "a", needs: ["implement"] },
    ]);

    const result = appendPullRequestDelivery(config, artifact);

    const rootNodes = result.workflows[result.root_workflow].nodes;
    const prNodes = rootNodes.filter(
      (n) => n.kind === "builtin" && n.builtin === "open-pull-request"
    );
    expect(prNodes).toHaveLength(1);
    expect(prNodes[0].needs).toEqual(["verify"]);
  });

  it("depends on all terminal nodes when there are multiple", () => {
    const config = baseConfig(true);
    const artifact = artifactWithNodes([
      { id: "branch-a", kind: "agent", profile: "a" },
      { id: "branch-b", kind: "agent", profile: "a" },
    ]);

    const result = appendPullRequestDelivery(config, artifact);

    const rootNodes = result.workflows[result.root_workflow].nodes;
    const prNode = rootNodes.find(
      (n) => n.kind === "builtin" && n.builtin === "open-pull-request"
    );
    expect(prNode).toBeDefined();
    expect(prNode?.needs?.sort()).toEqual(["branch-a", "branch-b"]);
  });

  it("is idempotent — running twice produces no duplicate PR node", () => {
    const config = baseConfig(true);
    const artifact = artifactWithNodes([
      { id: "impl", kind: "agent", profile: "a" },
    ]);

    const once = appendPullRequestDelivery(config, artifact);
    const twice = appendPullRequestDelivery(config, once);

    const rootNodes = twice.workflows[twice.root_workflow].nodes;
    const prNodes = rootNodes.filter(
      (n) => n.kind === "builtin" && n.builtin === "open-pull-request"
    );
    expect(prNodes).toHaveLength(1);
  });

  it("is idempotent — pre-existing PR node → no duplicate", () => {
    const config = baseConfig(true);
    const artifact = artifactWithNodes([
      { id: "impl", kind: "agent", profile: "a" },
      {
        builtin: "open-pull-request",
        id: "pr",
        kind: "builtin",
        needs: ["impl"],
      },
    ]);

    const result = appendPullRequestDelivery(config, artifact);

    const rootNodes = result.workflows[result.root_workflow].nodes;
    const prNodes = rootNodes.filter(
      (n) => n.kind === "builtin" && n.builtin === "open-pull-request"
    );
    expect(prNodes).toHaveLength(1);
  });

  it("returns artifact unchanged when the workflow has no nodes", () => {
    const config = baseConfig(true);
    const artifact = artifactWithNodes([]);

    const result = appendPullRequestDelivery(config, artifact);

    expect(result).toBe(artifact);
  });

  it("returns a new immutable artifact (does not mutate input)", () => {
    const config = baseConfig(true);
    const artifact = artifactWithNodes([
      { id: "impl", kind: "agent", profile: "a" },
    ]);
    const originalNodeCount =
      artifact.workflows[artifact.root_workflow].nodes.length;

    appendPullRequestDelivery(config, artifact);

    expect(artifact.workflows[artifact.root_workflow].nodes).toHaveLength(
      originalNodeCount
    );
  });
});
