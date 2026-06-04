import { afterEach, describe, expect, it } from "vitest";
import type {
  HookBinding,
  HookFunctionSpec,
  RuntimeContext,
} from "../contracts";
import { hookBindingMatchesContext, hookEnv } from "./hooks";

const originalPath = process.env.PATH;
const originalToken = process.env.PIPELINE_TOKEN;

afterEach(() => {
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  if (originalToken === undefined) {
    delete process.env.PIPELINE_TOKEN;
  } else {
    process.env.PIPELINE_TOKEN = originalToken;
  }
});

describe("runtime hooks", () => {
  it("matches hook bindings by workflow, node, and gate filters", () => {
    const binding: HookBinding = {
      failure: "ignore",
      function: "announce",
      id: "announce",
      where: {
        gate: "quality",
        node: "node-a",
        workflow: "default",
      },
    };

    expect(
      hookBindingMatchesContext(binding, "default", "node-a", "quality")
    ).toBe(true);
    expect(
      hookBindingMatchesContext(binding, "other", "node-a", "quality")
    ).toBe(false);
    expect(
      hookBindingMatchesContext(binding, "default", "node-b", "quality")
    ).toBe(false);
    expect(
      hookBindingMatchesContext(binding, "default", "node-a", "other")
    ).toBe(false);
  });

  it("builds command hook env from passthrough and explicit values", () => {
    process.env.PATH = "/bin";
    process.env.PIPELINE_TOKEN = "secret";
    const hook: Extract<HookFunctionSpec, { kind: "command" }> = {
      command: ["hook-bin"],
      env: {
        passthrough: ["PIPELINE_TOKEN"],
        set: { LOCAL_ONLY: "1" },
      },
      kind: "command",
      protocol: { input: "file", result: "file" },
      trusted: true,
    };
    const context = {
      hookPolicy: {
        allowCommandHooks: true,
        allowUntrustedCommandHooks: true,
        env: { GLOBAL_ONLY: "1" },
        envPassthrough: ["PATH"],
        outputLimitBytes: 1024,
        timeoutMs: 1000,
      },
    } as Pick<RuntimeContext, "hookPolicy">;

    expect(hookEnv(hook, context)).toEqual({
      GLOBAL_ONLY: "1",
      LOCAL_ONLY: "1",
      PATH: "/bin",
      PIPELINE_TOKEN: "secret",
    });
  });
});
