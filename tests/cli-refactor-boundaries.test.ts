import { Command } from "commander";
import { describe, expect, it } from "vitest";

import {
  createTerminalRuntimeReporter,
  formatRuntimeFailure,
  formatRuntimeProgressMessage,
  formatRuntimeResult,
} from "../src/cli/format";
import {
  addMokaSubmitOptions,
  buildMokaSubmitInputFromCli,
  parseImagePullPolicy,
} from "../src/cli/submit-options";

describe("PIPE-65 CLI refactor boundaries", () => {
  it("exposes runtime formatting helpers from src/cli/format", () => {
    expect(formatRuntimeProgressMessage).toEqual(expect.any(Function));
    expect(createTerminalRuntimeReporter).toEqual(expect.any(Function));
    expect(formatRuntimeResult).toEqual(expect.any(Function));
    expect(formatRuntimeFailure).toEqual(expect.any(Function));
  });

  it("exposes submit option helpers from src/cli/submit-options", () => {
    expect(addMokaSubmitOptions).toEqual(expect.any(Function));
    expect(buildMokaSubmitInputFromCli).toEqual(expect.any(Function));
    expect(parseImagePullPolicy).toEqual(expect.any(Function));
  });
});

describe("PIPE-65 CLI formatting behavior", () => {
  it("keeps terminal runtime event text unchanged after moving formatting out of index", () => {
    expect(
      formatRuntimeProgressMessage({
        nodeIds: ["research", "verify"],
        type: "workflow.start",
        workflowId: "root",
      })
    ).toBe("Pipeline starting: root (research -> verify)");

    expect(
      formatRuntimeProgressMessage({
        attempt: 2,
        nodeId: "research",
        profile: "pipeline-researcher",
        runnerId: "opencode",
        type: "node.start",
      })
    ).toBe(
      "Node starting: research runner=opencode profile=pipeline-researcher attempt=2"
    );
  });
});

describe("PIPE-65 moka submit option normalization", () => {
  it("keeps submit command options registered on the existing CLI surface", () => {
    const command = addMokaSubmitOptions(new Command("submit"));
    const optionNames = new Set(
      command.options.map((option) => option.long).filter(Boolean)
    );

    expect(optionNames).toEqual(
      new Set([
        "--quick",
        "--command",
        "--schedule",
        "--event-url",
        "--task",
        "--name",
        "--generate-name",
        "--namespace",
        "--kubeconfig",
        "--queue-name",
        "--service-account",
        "--image",
        "--image-pull-policy",
        "--image-pull-secret",
      ])
    );
  });

  it("normalizes image pull policy the same way as the current CLI", () => {
    expect(parseImagePullPolicy(undefined)).toBe("Always");
    expect(parseImagePullPolicy("Always")).toBe("Always");
    expect(parseImagePullPolicy("IfNotPresent")).toBe("IfNotPresent");
    expect(parseImagePullPolicy("Never")).toBe("Never");
    expect(parseImagePullPolicy("unexpected")).toBe("Always");
  });
});
