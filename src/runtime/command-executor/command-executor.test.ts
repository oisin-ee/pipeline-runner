import { spawnSync } from "node:child_process";

import { execa } from "execa";
import { beforeEach, describe, expect, it } from "vitest";

import { executeCommand } from "./command-executor";

const maybeMockExeca = execa as unknown as {
  mockImplementation?: (implementation: unknown) => unknown;
};

const spawnResponse = (
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string>;
    maxBuffer?: number;
  }
) => {
  const result = spawnSync(command, args, {
    cwd: options?.cwd,
    encoding: "utf-8",
    env: { ...process.env, ...options?.env },
    maxBuffer: options?.maxBuffer,
  });
  return {
    exitCode: result.status ?? 0,
    stderr: result.stderr.trim(),
    stdout: result.stdout.trim(),
  };
};

const mockExecaWithSpawnSync = (): void => {
  maybeMockExeca.mockImplementation?.(
    (
      command: string,
      args: string[] = [],
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        maxBuffer?: number;
      }
    ) => {
      const response = spawnResponse(command, args, options);
      if (response.exitCode !== 0) {
        throw response;
      }
      return response;
    }
  );
};

beforeEach(() => {
  mockExecaWithSpawnSync();
});

describe("executeCommand", () => {
  it("returns command output and evidence for successful commands", async () => {
    const result = await executeCommand(
      ["node", "-e", "console.log('hello')"],
      { worktreePath: process.cwd() }
    );

    expect(result).toMatchObject({
      evidence: ["command exited 0: node -e console.log('hello')"],
      exitCode: 0,
      output: "hello",
    });
  });

  it("reports failed commands and preserves stdout/stderr output", async () => {
    const result = await executeCommand(
      [
        "node",
        "-e",
        "console.log('out'); console.error('err'); process.exit(7)",
      ],
      {
        worktreePath: process.cwd(),
      }
    );

    expect(result.exitCode).toBe(7);
    expect(result.output).toBe("out\nerr");
    expect(result.evidence).toContain(
      "command exited 7: node -e console.log('out'); console.error('err'); process.exit(7)"
    );
    expect(result.evidence).toContain("out\nerr");
  });

  it("honors command output limits passed to execa", async () => {
    const result = await executeCommand(
      ["node", "-e", "console.log('abcdef')"],
      { worktreePath: process.cwd() },
      { outputLimitBytes: 3 }
    );

    expect(result.output).toBe("abc");
    expect(result.evidence[0]).toBe(
      "command exited 0: node -e console.log('abcdef')"
    );
    expect(Buffer.byteLength(result.output, "utf-8")).toBeLessThanOrEqual(3);
  });
});
