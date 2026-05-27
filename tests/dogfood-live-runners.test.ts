import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type PipelineConfig,
  parsePipelineConfigParts,
} from "../src/config.js";
import { runPipelineFromConfig } from "../src/pipeline-runtime.js";

const RUN_LIVE = process.env.PIPELINE_LIVE_RUNNERS === "1";
const describeLive = RUN_LIVE ? describe : describe.skip;
const FILESYSTEM_MODE_RE = /^(read-only|workspace-write)$/;

const LIVE_HARNESSES = ["codex", "claude", "kimi", "opencode", "pi"] as const;
type LiveHarness = (typeof LIVE_HARNESSES)[number];

type OutputFormat = "json" | "json_schema" | "jsonl" | "text";

interface HarnessSmokeSpec {
  filesystemModes: Array<"read-only" | "workspace-write">;
  mcpServers: boolean;
  outputFormats: OutputFormat[];
  rules: boolean;
  skills: boolean;
  tools: PipelineConfig["runners"][string]["capabilities"]["tools"];
}

const HARNESS_SPECS: Record<LiveHarness, HarnessSmokeSpec> = {
  claude: {
    filesystemModes: ["read-only", "workspace-write"],
    mcpServers: true,
    outputFormats: ["text", "json", "json_schema"],
    rules: true,
    skills: false,
    tools: ["read", "list", "grep", "glob", "bash", "edit", "write"],
  },
  codex: {
    filesystemModes: ["read-only", "workspace-write"],
    mcpServers: true,
    outputFormats: ["text", "json", "jsonl", "json_schema"],
    rules: true,
    skills: true,
    tools: ["read", "list", "grep", "glob", "bash", "edit", "write"],
  },
  kimi: {
    filesystemModes: ["read-only", "workspace-write"],
    mcpServers: false,
    outputFormats: ["text", "json"],
    rules: true,
    skills: false,
    tools: ["read", "list", "grep", "glob", "bash", "edit", "write"],
  },
  opencode: {
    filesystemModes: ["read-only", "workspace-write"],
    mcpServers: true,
    outputFormats: ["text", "json", "jsonl", "json_schema"],
    rules: true,
    skills: false,
    tools: ["read", "list", "grep", "glob", "bash", "edit", "write", "task"],
  },
  pi: {
    filesystemModes: ["read-only", "workspace-write"],
    mcpServers: false,
    outputFormats: ["text", "json"],
    rules: true,
    skills: true,
    tools: ["read", "list", "grep", "glob", "bash", "edit", "write"],
  },
};

const SELECTED_HARNESSES = selectedHarnesses();
const SELECTED_FORMATS = selectedFormats();
const MATRIX = SELECTED_HARNESSES.flatMap((harness) =>
  HARNESS_SPECS[harness].outputFormats
    .filter((format) => SELECTED_FORMATS.has(format))
    .map((format, index) => ({
      filesystem:
        HARNESS_SPECS[harness].filesystemModes[
          index % HARNESS_SPECS[harness].filesystemModes.length
        ],
      format,
      harness,
      profileId: `${harness}-${format.replace("_", "-")}`,
    }))
);

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describeLive("live runner smoke matrix", () => {
  it.each(
    MATRIX
  )("runs $harness with $format output and declared grants", async ({
    filesystem,
    format,
    harness,
    profileId,
  }) => {
    process.env.PIPELINE_AGENT_TIMEOUT_MS ??= "180000";
    const project = makeProject();
    const config = liveRunnerConfig(project, {
      filesystem,
      format,
      harness,
      profileId,
    });

    const result = await runPipelineFromConfig({
      config,
      task: `Return the live smoke PASS object for ${profileId}.`,
      workflowId: "live",
      worktreePath: project,
    });
    const diagnostic = runtimeDiagnostic(result);

    expect(result.outcome, diagnostic).toBe("PASS");
    expect(result.nodes, diagnostic).toHaveLength(1);

    const node = result.nodes[0];
    expect(node?.status, diagnostic).toBe("passed");
    expect(node?.output, diagnostic).toContain("PASS");

    const parsed = JSON.parse(node?.output ?? "{}") as {
      evidence?: string[];
      verdict?: string;
    };
    expect(parsed.verdict, diagnostic).toBe("PASS");
    expect(parsed.evidence, diagnostic).toContain(`${profileId} live smoke`);

    const nodeGates = result.gates.filter(
      (gate) => gate.nodeId === node?.nodeId
    );
    expect(
      nodeGates.some((gate) => gate.kind === "verdict" && gate.passed),
      diagnostic
    ).toBe(true);
    if (format === "json_schema") {
      expect(
        nodeGates.some((gate) => gate.kind === "json_schema" && gate.passed),
        diagnostic
      ).toBe(true);
    }

    expect(result.agentInvocations.length, diagnostic).toBeGreaterThan(0);
    const plan = result.agentInvocations.at(-1);
    expect(plan?.type, diagnostic).toBe(harness);
    expect(plan?.runnerId, diagnostic).toBe(harness);
    expect(plan?.profileId, diagnostic).toBe(profileId);
    expect(plan?.strategy, diagnostic).toBe("native");
    expect(plan?.outputFormat, diagnostic).toBe(format);
    assertLaunchPlanContainsGrants(config, profileId, diagnostic);
  }, 240_000);
});

function selectedHarnesses(): LiveHarness[] {
  const raw = process.env.PIPELINE_LIVE_RUNNER_HARNESSES;
  if (!raw) {
    return [...LIVE_HARNESSES];
  }
  const allowed = new Set<string>(LIVE_HARNESSES);
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (!allowed.has(item)) {
        throw new Error(
          `Unsupported PIPELINE_LIVE_RUNNER_HARNESSES value '${item}'`
        );
      }
      return item as LiveHarness;
    });
}

function selectedFormats(): Set<OutputFormat> {
  const raw = process.env.PIPELINE_LIVE_RUNNER_FORMATS;
  if (!raw) {
    return new Set(["json", "json_schema", "jsonl", "text"]);
  }
  const allowed = new Set(["json", "json_schema", "jsonl", "text"]);
  return new Set(
    raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        if (!allowed.has(item)) {
          throw new Error(
            `Unsupported PIPELINE_LIVE_RUNNER_FORMATS value '${item}'`
          );
        }
        return item as OutputFormat;
      })
  );
}

function makeProject(): string {
  const project = mkdtempSync(join(tmpdir(), "pipeline-live-runners-"));
  tempDirs.push(project);
  writeProjectFile(project, "package.json", JSON.stringify({ type: "module" }));
  writeProjectFile(
    project,
    ".pipeline/schemas/live.schema.json",
    JSON.stringify(
      {
        additionalProperties: false,
        properties: {
          evidence: { items: { type: "string" }, type: "array" },
          verdict: { enum: ["PASS"], type: "string" },
        },
        required: ["verdict", "evidence"],
        type: "object",
      },
      null,
      2
    )
  );
  writeProjectFile(
    project,
    ".pipeline/rules/live.md",
    "Return the requested JSON object exactly; no Markdown fences.\n"
  );
  writeProjectFile(
    project,
    ".agents/skills/live/SKILL.md",
    "# Live Smoke Skill\n\nReturn the requested JSON object exactly.\n"
  );
  writeProjectFile(project, "mcp-server.cjs", MCP_SERVER);
  return project;
}

function liveRunnerConfig(
  project: string,
  spec: {
    filesystem: "read-only" | "workspace-write";
    format: OutputFormat;
    harness: LiveHarness;
    profileId: string;
  }
): PipelineConfig {
  const { filesystem, format, harness, profileId } = spec;
  const harnessSpec = HARNESS_SPECS[harness];
  const nodeId = `run-${profileId}`;
  const mcpScript = join(project, "mcp-server.cjs");
  return parsePipelineConfigParts(
    {
      pipeline: `
version: 1
default_workflow: live
orchestrator:
  profile: orchestrator
workflows:
  live:
    nodes:
      - id: ${nodeId}
        kind: agent
        profile: ${profileId}
        retries: { max_attempts: 3 }
        gates:
          - id: verdict-${profileId}
            kind: verdict
`,
      profiles: `
version: 1
rules:
  live-rule:
    path: .pipeline/rules/live.md
skills:
  live-skill:
    path: .agents/skills/live/SKILL.md
mcp_servers:
  live-mcp:
    command: ${JSON.stringify(process.execPath)}
    args: [${JSON.stringify(mcpScript)}]
    env: { PIPELINE_LIVE_MCP: smoke }
profiles:
  orchestrator:
    runner: codex
    instructions: { inline: "Orchestrate the live runner smoke." }
    rules: [live-rule]
    skills: [live-skill]
    mcp_servers: [live-mcp]
    tools: [read, list, grep, glob, bash]
    filesystem: { mode: read-only }
    network: { mode: inherit }
  ${profileId}:
    runner: ${harness}
    instructions:
      inline: ${JSON.stringify(
        [
          `Return only this JSON object and no Markdown: {"verdict":"PASS","evidence":["${profileId} live smoke"]}.`,
          "Do not inspect files.",
          "Do not run tools.",
        ].join(" ")
      )}
    ${harnessSpec.rules ? "rules: [live-rule]" : ""}
    ${harnessSpec.skills ? "skills: [live-skill]" : ""}
    ${harnessSpec.mcpServers ? "mcp_servers: [live-mcp]" : ""}
    tools: [${(harnessSpec.tools ?? []).join(", ")}]
    filesystem: { mode: ${filesystem} }
    network: { mode: inherit }
    output:
      format: ${format}
      ${format === "json_schema" ? "schema_path: .pipeline/schemas/live.schema.json" : ""}
      ${format === "json_schema" ? "repair: { enabled: false }" : ""}
`,
      runners: `
version: 1
runners:
  codex:
    type: codex
    command: codex
    capabilities:
      native_subagents: true
      rules: true
      skills: true
      mcp_servers: true
      tools: [read, list, grep, glob, bash, edit, write]
      filesystem: [read-only, workspace-write]
      network: [inherit]
      output_formats: [text, json, jsonl, json_schema]
  claude:
    type: claude
    command: claude
    capabilities:
      native_subagents: true
      rules: true
      skills: false
      mcp_servers: true
      tools: [read, list, grep, glob, bash, edit, write]
      filesystem: [read-only, workspace-write]
      network: [inherit]
      output_formats: [text, json, json_schema]
  opencode:
    type: opencode
    command: opencode
    model: ${JSON.stringify(process.env.PIPELINE_OPENCODE_MODEL ?? "openai/gpt-5.4-mini-fast")}
    capabilities:
      native_subagents: true
      rules: true
      skills: false
      mcp_servers: true
      tools: [read, list, grep, glob, bash, edit, write, task]
      filesystem: [read-only, workspace-write]
      network: [inherit]
      output_formats: [text, json, jsonl, json_schema]
  kimi:
    type: kimi
    command: kimi
    capabilities:
      native_subagents: true
      rules: true
      skills: false
      mcp_servers: false
      tools: [read, list, grep, glob, bash, edit, write]
      filesystem: [read-only, workspace-write]
      network: [inherit]
      output_formats: [text, json]
  pi:
    type: pi
    command: pi
    capabilities:
      native_subagents: true
      rules: true
      skills: true
      mcp_servers: false
      tools: [read, list, grep, glob, bash, edit, write]
      filesystem: [read-only, workspace-write]
      network: [inherit]
      output_formats: [text, json]
`,
    },
    project
  );
}

function assertLaunchPlanContainsGrants(
  config: PipelineConfig,
  profileId: string,
  diagnostic: string
): void {
  const profile = config.profiles[profileId];
  const plan = config.workflows.live.nodes[0];
  assertSmoke(
    plan?.kind === "agent" && plan.profile === profileId,
    "profile id did not match",
    diagnostic
  );
  assertSmoke(
    arrayEquals(profile?.rules, ["live-rule"]),
    "rule grant was not attached",
    diagnostic
  );
  assertSmoke(
    FILESYSTEM_MODE_RE.test(profile?.filesystem?.mode ?? ""),
    "filesystem grant was not attached",
    diagnostic
  );
  assertSmoke(
    profile?.network?.mode === "inherit",
    "network grant was not attached",
    diagnostic
  );
  assertSmoke(
    (profile?.tools?.length ?? 0) > 0,
    "tool grants were not attached",
    diagnostic
  );
  if (profile?.runner === "codex" || profile?.runner === "pi") {
    assertSmoke(
      arrayEquals(profile.skills, ["live-skill"]),
      `${profile.runner} skill grant was not attached`,
      diagnostic
    );
  }
  if (profile?.runner === "kimi" || profile?.runner === "pi") {
    assertSmoke(
      arrayEquals(profile.mcp_servers ?? [], []),
      `${profile.runner} should not receive MCP grants`,
      diagnostic
    );
  }
  if (profile?.runner !== "kimi" && profile?.runner !== "pi") {
    assertSmoke(
      arrayEquals(profile?.mcp_servers, ["live-mcp"]),
      "MCP grant was not attached",
      diagnostic
    );
  }
}

function arrayEquals(left: string[] | undefined, right: string[]): boolean {
  return (
    (left?.length ?? 0) === right.length &&
    right.every((item, index) => left?.[index] === item)
  );
}

function assertSmoke(
  condition: boolean,
  message: string,
  diagnostic: string
): void {
  if (!condition) {
    throw new Error(`${message}\n${diagnostic}`);
  }
}

function runtimeDiagnostic(
  result: Awaited<ReturnType<typeof runPipelineFromConfig>>
): string {
  return JSON.stringify(
    {
      failureDetails: result.failureDetails,
      gates: result.gates,
      invocations: result.agentInvocations.map((plan) => ({
        args: redactLongPrompt(plan.args),
        env: plan.env,
        outputFormat: plan.outputFormat,
        profileId: plan.profileId,
        runnerId: plan.runnerId,
        strategy: plan.strategy,
        type: plan.type,
      })),
      nodes: result.nodes.map((node) => ({
        evidence: node.evidence,
        exitCode: node.exitCode,
        nodeId: node.nodeId,
        output: node.output,
        status: node.status,
      })),
      outcome: result.outcome,
    },
    null,
    2
  );
}

function redactLongPrompt(args: string[]): string[] {
  return args.map((arg) =>
    arg.length > 500 ? `${arg.slice(0, 500)}...<truncated>` : arg
  );
}

function writeProjectFile(root: string, path: string, content: string): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

const MCP_SERVER = String.raw`
const stdin = process.stdin;
let buffer = Buffer.alloc(0);

stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  processMessages();
});

function processMessages() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return;
    }
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) {
      return;
    }
    const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.subarray(bodyEnd);
    handleMessage(body);
  }
}

function handleMessage(body) {
  let message;
  try {
    message = JSON.parse(body);
  } catch {
    return;
  }
  if (message.id === undefined || message.id === null) {
    return;
  }
  respond({
    id: message.id,
    jsonrpc: "2.0",
    result: resultFor(message.method),
  });
}

function resultFor(method) {
  if (method === "initialize") {
    return {
      capabilities: {},
      protocolVersion: "2024-11-05",
      serverInfo: { name: "pipeline-live-smoke", version: "1.0.0" },
    };
  }
  if (method === "tools/list") {
    return { tools: [] };
  }
  if (method === "resources/list") {
    return { resources: [] };
  }
  if (method === "prompts/list") {
    return { prompts: [] };
  }
  if (method === "shutdown") {
    return null;
  }
  return {};
}

function respond(message) {
  const body = JSON.stringify(message);
  process.stdout.write(
    "Content-Length: " + Buffer.byteLength(body, "utf8") + "\r\n\r\n" + body
  );
}
`.trimStart();
