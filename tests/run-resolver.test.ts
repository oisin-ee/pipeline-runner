import { describe, expect, it } from "vitest";

interface RunResolverFlags {
  effort?: "normal" | "quick" | "thorough";
  readOnly?: boolean;
  schedule?: string;
  target?: "local" | "remote";
  workflow?: string;
}

interface RunResolution {
  effort: "normal" | "quick" | "thorough";
  execution: Record<string, unknown>;
  mode: "read" | "write";
  target: "local" | "remote";
}

interface RunResolverModule {
  resolveMokaRun(input: { flags?: RunResolverFlags; task: string }): RunResolution;
}

const resolveMokaRun = async (input: { flags?: RunResolverFlags; task?: string }): Promise<RunResolution> => {
  const modulePath = "../src/cli/run-resolver";
  const mod = (await import(modulePath)) as RunResolverModule;
  return mod.resolveMokaRun({ task: input.task ?? "Ship it", ...input });
};

describe("resolveMokaRun", () => {
  it("defaults bare moka run to local normal write mode", async () => {
    await expect(resolveMokaRun({})).resolves.toMatchObject({
      effort: "normal",
      execution: { kind: "local-runtime" },
      mode: "write",
      target: "local",
    });
  });

  it("maps --read-only to the inspect workflow", async () => {
    await expect(resolveMokaRun({ flags: { readOnly: true } })).resolves.toMatchObject({
      execution: { kind: "local-runtime", workflow: "inspect" },
      mode: "read",
      target: "local",
    });
  });

  it.each([
    ["quick", "quick"],
    ["thorough", "execute"],
  ] as const)("maps --effort %s to the %s scheduled entrypoint", async (effort, entrypoint) => {
    await expect(resolveMokaRun({ flags: { effort } })).resolves.toMatchObject({
      effort,
      execution: { entrypoint, kind: "local-runtime" },
      mode: "write",
      target: "local",
    });
  });

  it("keeps --workflow as an advanced local runtime override", async () => {
    await expect(resolveMokaRun({ flags: { effort: "quick", workflow: "inspect" } })).resolves.toMatchObject({
      execution: { kind: "local-runtime", workflow: "inspect" },
      target: "local",
    });
  });

  it("keeps --schedule as an approved schedule execution path", async () => {
    await expect(
      resolveMokaRun({
        flags: { schedule: ".pipeline/runs/run-a/schedule.yaml" },
      }),
    ).resolves.toMatchObject({
      execution: {
        kind: "local-runtime",
        schedule: ".pipeline/runs/run-a/schedule.yaml",
      },
      target: "local",
    });
  });

  it("routes --target remote through the graph submit path", async () => {
    await expect(resolveMokaRun({ flags: { effort: "quick", target: "remote" } })).resolves.toMatchObject({
      execution: { kind: "remote-submit", mode: "quick" },
      target: "remote",
    });
  });
});
