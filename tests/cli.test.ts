import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

import { execa } from "execa";

const mockExeca = execa as unknown as ReturnType<typeof vi.fn>;
const DESCRIPTION_RE = /description/i;
const FAILURE_DETAILS_RE =
  /verify: missing artifact[\s\S]*agent boundary node=verify[\s\S]*raw verifier output/;
const COMMAND_CONTINUATION_RE = /^ {20,}\S/;
const COMMAND_SUMMARY_RE = /^ {2}([a-z][\w-]*)(?:\s|$)(.*)$/;
const NON_CANONICAL_ENTRYPOINT_RE = /\b(?:alias|preset|compatibility)\b/i;
const PRIMARY_COMMAND_RE = /\bprimary\b/i;

const PIPELINE_YAML_SOURCE_RE = /from pipeline\.yaml/i;
const SCHEDULE_PATH_RE =
  /Schedule generated: \.pipeline\/runs\/run-\d{14}\/schedule\.yaml/;
const SCHEDULE_RUN_WORKFLOW_RE = /Workflow: schedule-run-\d{14}-root/;
const NO_REPO_COPY_RE = /clone|copy|mirror/i;
const MISSING_TOOLHIVE_WORKLOAD_RE = /missing ToolHive workload/;
const ORIGINAL_PIPELINE_MCP_GATEWAY_AUTHORIZATION =
  process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION;
const ORIGINAL_PIPELINE_TEST_COMMAND = process.env.PIPELINE_TEST_COMMAND;
const CLAUDE_GATEWAY_AUTH_HEADER = [
  "$",
  "{PIPELINE_MCP_GATEWAY_AUTHORIZATION}",
].join("");
const DEFAULT_TEST_SKILLS = [
  "add-dark-mode",
  "brand-kit",
  "canonicalize-tailwind",
  "componentize",
  "critique",
  "dark-mode-image",
  "design",
  "diagnose",
  "doubt",
  "execute",
  "fix",
  "grill",
  "ideas",
  "imagegen",
  "improve",
  "inspect",
  "library-first-development",
  "make-responsive",
  "markup-from-image",
  "migrate",
  "optimize",
  "quality-gate",
  "quick",
  "research",
  "schedule-graph-shaping",
  "scope",
  "secure",
  "spec",
  "test",
  "trace",
  "verify",
];

interface MockAgentResponse {
  matches: (prompt: string) => boolean;
  response: unknown;
}

const MOCK_AGENT_RESPONSES: MockAgentResponse[] = [
  {
    matches: (prompt) =>
      prompt.includes("moka-acceptance-reviewer") ||
      prompt.includes("acceptance reviewer"),
    response: {
      verdict: "PASS",
      evidence: ["acceptance passed"],
      acceptance: [{ id: "1", verdict: "PASS", evidence: ["accepted"] }],
      violations: [],
    },
  },
  {
    matches: (prompt) =>
      prompt.includes("moka-verifier") || prompt.includes("verifier"),
    response: {
      verdict: "PASS",
      evidence: ["verified by CLI fixture"],
    },
  },
  {
    matches: (prompt) =>
      prompt.includes("moka-learner") || prompt.includes("LEARN phase"),
    response: {
      qdrant: { attempted: true, succeeded: true },
      evidence: ["stored lesson"],
    },
  },
  {
    matches: (prompt) => prompt.includes("moka-researcher"),
    response: {
      ac: ["package OpenCode schedule completes"],
      findings: ["researched package schedule"],
      risks: [],
    },
  },
];

const DEFAULT_MOCK_AGENT_RESPONSE = {
  changes: [
    {
      files: ["src/app.ts"],
      summary: "Implemented CLI fixture task",
      why: "The OpenCode-first schedule agent must report changes",
    },
  ],
  verification: ["CLI fixture verified"],
};

function mockAgentStdout(command: string, args?: string[]): string {
  if (command !== "opencode") {
    return "";
  }
  const prompt = Array.isArray(args) ? args.join("\n") : "";
  if (prompt.includes("Create a pipeline schedule")) {
    return [
      "version: 1",
      "kind: pipeline-schedule",
      "schedule_id: run-20260603010101",
      "source_entrypoint: execute",
      "task: CLI scheduled fixture",
      "generated_at: 2026-06-03T01:01:01.000Z",
      "root_workflow: root",
      "workflows:",
      "  root:",
      "    nodes:",
      "      - id: scheduled",
      "        kind: command",
      "        command: [node, -e, \"console.log('scheduled')\"]",
      "",
    ].join("\n");
  }
  return JSON.stringify(
    MOCK_AGENT_RESPONSES.find(({ matches }) => matches(prompt))?.response ??
      DEFAULT_MOCK_AGENT_RESPONSE
  );
}

/**
 * Minimal opencode serve stub used by CLI tests that exercise the SDK transport
 * (PIPE-73). Implements the three endpoints the SDK executor calls:
 *   POST /session                → creates a session
 *   GET  /event                  → empty SSE stream (no events)
 *   POST /session/{id}/message   → returns a mock agent response
 *
 * Set OPENCODE_SERVER_URL to the returned url before running the CLI, then call
 * stop() in afterEach to close the server.
 */
interface OpencodeStub {
  promptBodies: Array<{
    agent?: string;
    model?: { modelID: string; providerID: string };
    parts: Array<{ text: string; type: string }>;
    variant?: string;
  }>;
  stop(): Promise<void>;
  url: string;
}

function startOpencodeStub(): Promise<OpencodeStub> {
  const promptBodies: OpencodeStub["promptBodies"] = [];

  function respond(
    res: ServerResponse,
    status: number,
    body: unknown,
    contentType = "application/json"
  ): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": contentType,
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on("end", () => {
        resolve(Buffer.concat(chunks).toString());
      });
      req.on("error", reject);
    });
  }

  const server: Server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? "";
      const method = req.method ?? "GET";

      // POST /session — create a new session
      if (
        method === "POST" &&
        url.startsWith("/session") &&
        !url.includes("/message")
      ) {
        respond(res, 200, { id: "stub-session-1" });
        return;
      }

      // GET /event — empty SSE stream (no events; closes immediately)
      if (method === "GET" && url.startsWith("/event")) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.end();
        return;
      }

      // POST /session/{id}/message — agent prompt
      if (method === "POST" && url.includes("/message")) {
        const raw = await readBody(req);
        let body: OpencodeStub["promptBodies"][number] = { parts: [] };
        try {
          body = JSON.parse(raw) as typeof body;
        } catch {
          // ignore parse error, use empty body
        }
        promptBodies.push(body);

        const promptText = body.parts.map((p) => p.text).join("\n");
        const text = mockAgentStdout("opencode", [promptText]);
        respond(res, 200, {
          parts: [{ type: "text", text, sessionID: "stub-session-1" }],
        });
        return;
      }

      respond(res, 404, { error: `stub: unhandled ${method} ${url}` });
    }
  );

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get stub server address"));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({
        promptBodies,
        stop: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res()))
          ),
        url,
      });
    });
    server.on("error", reject);
  });
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

const HOST_CONFIG_ENV_KEYS = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "OPENCODE_CONFIG_DIR",
  "GEMINI_CONFIG_DIR",
  // Sandbox HOME so loadMokaGlobalConfig() reads from the temp dir, not the
  // developer's real ~/.config/moka/config.yaml.
  "HOME",
];

function redirectHostConfig(root: string): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of HOST_CONFIG_ENV_KEYS) {
    saved[key] = process.env[key];
  }
  process.env.CLAUDE_CONFIG_DIR = join(root, ".claude");
  process.env.CODEX_HOME = join(root, ".codex");
  process.env.OPENCODE_CONFIG_DIR = join(root, ".opencode");
  process.env.GEMINI_CONFIG_DIR = join(root, ".gemini");
  process.env.HOME = root;
  return saved;
}

function restoreHostConfig(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    restoreEnv(key, value);
  }
}

type ConsoleSpy = ReturnType<typeof vi.spyOn>;
type RunCli = typeof import("../src/index")["runCli"];

interface CliTargetFixture {
  error: ConsoleSpy;
  log: ConsoleSpy;
  output: () => string;
  runCli: RunCli;
  stderr: () => string;
}

interface CliTempFixture extends CliTargetFixture {
  dir: string;
}

interface CliOutputCapture {
  failureText?: string;
  stderr: string;
  stdout: string;
  thrown?: unknown;
}

const EXECUTE_SHIP_IT_ARGV = [
  "node",
  "/repo/node_modules/.bin/oisin-pipeline",
  "run",
  "--entrypoint",
  "execute",
  "ship",
  "it",
];

const GATEWAY_DOCTOR_ARGV = [
  "node",
  "/repo/node_modules/.bin/oisin-pipeline",
  "mcp",
  "gateway",
  "doctor",
];

function spyOutput(spy: ConsoleSpy): string {
  return spy.mock.calls.map(([message]) => String(message)).join("\n");
}

function topLevelCommandSummaries(help: string): Map<string, string> {
  const summaries = new Map<string, string>();
  let currentCommand: string | null = null;
  for (const line of help.split("\n")) {
    const commandLine = line.match(COMMAND_SUMMARY_RE);
    if (commandLine) {
      currentCommand = commandLine[1];
      summaries.set(currentCommand, line.trim().replace(/\s+/g, " "));
      continue;
    }
    if (currentCommand && COMMAND_CONTINUATION_RE.test(line)) {
      summaries.set(
        currentCommand,
        `${summaries.get(currentCommand) ?? ""} ${line.trim()}`.replace(
          /\s+/g,
          " "
        )
      );
    }
  }
  return summaries;
}

function kubectlCalls(): string[][] {
  return mockExeca.mock.calls
    .filter(([command]) => command === "kubectl")
    .map(([, args]) => args as string[]);
}

function clusterDoctorExecaResult(command: string, args: string[]) {
  if (command !== "kubectl") {
    return Promise.resolve({ exitCode: 0, stderr: "", stdout: "ok" });
  }
  const kubectlArgs = stripKubectlContext(args);
  if (
    kubectlArgs.join(" ") ===
    "auth can-i create workflows.argoproj.io -n test-ns"
  ) {
    return Promise.resolve({ exitCode: 0, stderr: "", stdout: "no" });
  }
  if (kubectlArgs.includes("pipeline-runner-event-auth")) {
    return Promise.reject({ stderr: "not found" });
  }
  if (kubectlArgs.join(" ") === "get clustersecretstore openbao -o json") {
    return Promise.resolve({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        status: {
          conditions: [
            {
              message: "OpenBao auth drift blocks ESO sync",
              status: "False",
              type: "Ready",
            },
          ],
        },
      }),
    });
  }
  if (kubectlArgs.includes("-o") && kubectlArgs.includes("json")) {
    return Promise.resolve({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        status: { conditions: [{ status: "True", type: "Ready" }] },
      }),
    });
  }
  return Promise.resolve({ exitCode: 0, stderr: "", stdout: "present" });
}

function stripKubectlContext(args: string[]): string[] {
  return args[0] === "--context" ? args.slice(2) : args;
}

function readPackageVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(join(process.cwd(), "package.json"), "utf8")
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error("Expected package.json to define a string version");
  }
  return packageJson.version;
}

async function withCliTarget(
  targetPath: string,
  run: (fixture: CliTargetFixture) => Promise<void>
): Promise<void> {
  const { runCli } = await import("../src/index");
  const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    process.env.PIPELINE_TARGET_PATH = targetPath;
    await run({
      error,
      log,
      output: () => spyOutput(log),
      runCli,
      stderr: () => spyOutput(error),
    });
  } finally {
    log.mockRestore();
    error.mockRestore();
    restoreEnv("PIPELINE_TARGET_PATH", originalTargetPath);
  }
}

async function withCliTempDir(
  prefix: string,
  run: (fixture: CliTempFixture) => Promise<void>
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const savedHostEnv: Record<string, string | undefined> = {};
  const hostEnvKeys = [
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "OPENCODE_CONFIG_DIR",
    "GEMINI_CONFIG_DIR",
    // Sandbox HOME so loadMokaGlobalConfig() (used by cluster-doctor) reads from
    // the temp dir rather than the developer's real ~/.config/moka/config.yaml.
    "HOME",
  ];
  try {
    writeMockSkills(DEFAULT_TEST_SKILLS, dir, [], false);
    // Redirect per-machine host dirs into `dir` so installed harness files land
    // under `dir` and existing path assertions (join(dir, ".opencode/…")) work.
    for (const key of hostEnvKeys) {
      savedHostEnv[key] = process.env[key];
    }
    process.env.CLAUDE_CONFIG_DIR = join(dir, ".claude");
    process.env.CODEX_HOME = join(dir, ".codex");
    process.env.OPENCODE_CONFIG_DIR = join(dir, ".opencode");
    process.env.GEMINI_CONFIG_DIR = join(dir, ".gemini");
    process.env.HOME = dir;
    await withCliTarget(dir, (fixture) => run({ ...fixture, dir }));
  } finally {
    for (const [key, value] of Object.entries(savedHostEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withDirectInitDir(
  prefix: string,
  run: (fixture: { dir: string; runCli: RunCli }) => Promise<void>
): Promise<void> {
  const { runCli } = await import("../src/index");
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
  const savedHostEnv: Record<string, string | undefined> = {};
  const hostEnvKeys = [
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "OPENCODE_CONFIG_DIR",
    "GEMINI_CONFIG_DIR",
  ];
  try {
    process.env.PIPELINE_TARGET_PATH = dir;
    for (const key of hostEnvKeys) {
      savedHostEnv[key] = process.env[key];
    }
    process.env.CLAUDE_CONFIG_DIR = join(dir, ".claude");
    process.env.CODEX_HOME = join(dir, ".codex");
    process.env.OPENCODE_CONFIG_DIR = join(dir, ".opencode");
    process.env.GEMINI_CONFIG_DIR = join(dir, ".gemini");
    await run({ dir, runCli });
  } finally {
    for (const [key, value] of Object.entries(savedHostEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    restoreEnv("PIPELINE_TARGET_PATH", originalTargetPath);
    rmSync(dir, { recursive: true, force: true });
  }
}

function generatedHostFilesExist(root: string, paths: string[]): boolean {
  return paths.every((relativePath) => existsSync(join(root, relativePath)));
}

function hasMcpmRegistration(): boolean {
  return mockExeca.mock.calls.some(
    ([command, args]) =>
      command === "uvx" && Array.isArray(args) && args.includes("mcpm")
  );
}

function executeShipIt(runCli: RunCli): Promise<void> {
  return runCli(EXECUTE_SHIP_IT_ARGV);
}

function runGatewayDoctor(runCli: RunCli): Promise<void> {
  return runCli(GATEWAY_DOCTOR_ARGV);
}

async function prepareGatewayWorkspace(
  runCli: RunCli,
  dir: string,
  options: { init?: boolean } = {}
): Promise<void> {
  if (options.init) {
    await runCli(["node", "/repo/node_modules/.bin/oisin-pipeline", "init"]);
  }
  mkdirSync(join(dir, ".serena"), { recursive: true });
  writeFileSync(join(dir, ".serena/project.yml"), "name: test\n");
  mkdirSync(join(dir, "backlog"), { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}\n");
}

async function validateCliLintFixture(
  fixture: CliTempFixture,
  parts: Parameters<typeof writeCliValidateLintConfig>[1]
): Promise<CliOutputCapture> {
  writeCliValidateLintConfig(fixture.dir, parts);
  await fixture.runCli([
    "node",
    "/repo/node_modules/.bin/oisin-pipeline",
    "validate",
  ]);
  return {
    stderr: fixture.stderr(),
    stdout: fixture.output(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION = "Basic test-basic-payload";
  mockExeca.mockImplementation(((
    command: string,
    args?: string[],
    options?: { cwd?: string; env?: Record<string, string> }
  ) => {
    if (options?.env?.PIPELINE_HOOK_RESULT) {
      writeFileSync(
        options.env.PIPELINE_HOOK_RESULT,
        JSON.stringify({ status: "pass", summary: command })
      );
    }
    if (
      command === "npx" &&
      Array.isArray(args) &&
      args.includes("skills") &&
      args.includes("add")
    ) {
      installMockSkills(args, (options as { cwd?: string } | undefined)?.cwd);
    }
    installMockAgentRepoIfRequested(command, args);
    return Promise.resolve({
      exitCode: 0,
      stderr: "",
      stdout: mockAgentStdout(command, args),
    }) as any;
  }) as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_PIPELINE_MCP_GATEWAY_AUTHORIZATION === undefined) {
    delete process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION;
  } else {
    process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION =
      ORIGINAL_PIPELINE_MCP_GATEWAY_AUTHORIZATION;
  }
  restoreEnv("PIPELINE_TEST_COMMAND", ORIGINAL_PIPELINE_TEST_COMMAND);
});
function installMockSkills(args: string[], cwd = process.cwd()): void {
  const skillIndex = args.indexOf("--skill");
  if (skillIndex < 0) {
    return;
  }
  const requestedSkills = args
    .slice(skillIndex + 1)
    .filter((arg) => !arg.startsWith("-"));
  const skills = requestedSkills.includes("*")
    ? DEFAULT_TEST_SKILLS
    : requestedSkills;
  const agents = args.flatMap((arg, index) =>
    arg === "--agent" && args[index + 1] ? [args[index + 1]] : []
  );
  writeMockSkills(skills, cwd, agents, args.includes("--copy"));
}

function isAgentRepoClone(args: string[]): boolean {
  return args.slice(0, 3).join(" ") === "repo clone oisin-ee/agent";
}

function installMockAgentRepoIfRequested(
  command: string,
  args: string[] | undefined
): void {
  if (command === "gh" && Array.isArray(args) && isAgentRepoClone(args)) {
    installMockAgentRepo(args[3]);
  }
}

function installMockAgentRepo(target: string): void {
  writeFileAt(
    target,
    "hooks/claude-code/hooks/check.sh",
    "#!/bin/sh\necho claude\n"
  );
  writeFileAt(target, "hooks/codex/hooks/check.sh", "#!/bin/sh\necho codex\n");
  writeFileAt(
    target,
    "hooks/opencode/plugin/agent-hooks.ts",
    "export const AgentHooks = async () => ({})\n"
  );
  writeFileAt(target, "rules/00-test.md", "# Test Rule\n");
}

function writeFileAt(root: string, path: string, content: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function writeMockSkills(
  skills: string[],
  cwd: string,
  agents: string[] = ["opencode", "codex", "claude-code"],
  copy = true
): void {
  const lock: Record<string, unknown> = { skills: {}, version: 1 };
  for (const skill of skills) {
    writeMockSkillFile(
      cwd,
      join(".agents", "skills", skill, "SKILL.md"),
      skill
    );
    if (copy && agents.includes("claude-code")) {
      writeMockSkillFile(
        cwd,
        join(".claude", "skills", skill, "SKILL.md"),
        skill
      );
    }
    (lock.skills as Record<string, unknown>)[skill] = { source: "mock" };
  }
  writeFileSync(join(cwd, "skills-lock.json"), `${JSON.stringify(lock)}\n`);
}

function writeMockSkillFile(
  cwd: string,
  relativePath: string,
  skill: string
): void {
  const path = join(cwd, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `---\nname: ${skill}\ndescription: Mock ${skill} skill.\n---\n\n# ${skill}\n`
  );
}

function writeCliProjectFile(
  root: string,
  path: string,
  content: string
): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function writeCliEntrypointConfig(root: string): void {
  writeProjectFileSet(root, {
    ".pipeline/runners.yaml": `
version: 1
runners:
  local:
    type: command
    command: node
    capabilities:
      native_subagents: false
      output_formats: [text]
`,
    ".pipeline/profiles.yaml": `
version: 1
profiles:
  orchestrator:
    runner: local
    instructions: { inline: Orchestrate }
`,
    ".pipeline/pipeline.yaml": `
version: 1
default_workflow: default
entrypoints:
  quick:
    workflow: quick
    description: Quick custom workflow
  inspect:
    workflow: inspect
    description: Inspect custom workflow
  validate:
    workflow: validate-entrypoint
    description: Validate entrypoint workflow
orchestrator:
  profile: orchestrator
hooks:
  functions:
    default-start:
      kind: command
      command: [default-start-bin]
      trusted: true
    quick-start:
      kind: command
      command: [quick-start-bin]
      trusted: true
    validate-start:
      kind: command
      command: [validate-start-bin]
      trusted: true
  on:
    workflow.start:
      - id: default-start
        function: default-start
        where: { workflow: default }
        failure: fail
      - id: quick-start
        function: quick-start
        where: { workflow: quick }
        failure: fail
      - id: validate-start
        function: validate-start
        where: { workflow: validate-entrypoint }
        failure: fail
workflows:
  default:
    nodes:
      - id: default-node
        kind: command
        command: [default-node-bin]
  quick:
    description: Quick custom workflow
    nodes:
      - id: quick-node
        kind: command
        command: [quick-node-bin]
  inspect:
    description: Inspect custom workflow
    nodes:
      - id: inspect-node
        kind: command
        command: [inspect-node-bin]
  validate-entrypoint:
    description: Validate entrypoint workflow
    nodes:
      - id: validate-node
        kind: command
        command: [validate-entrypoint-bin]
`,
  });
}

function writeScheduledCliConfig(root: string): void {
  writeProjectFileSet(root, {
    ".pipeline/runners.yaml": `
version: 1
runners:
  local:
    type: command
    command: scheduled-runner
    capabilities:
      native_subagents: false
      output_formats: [text]
  opencode:
    type: opencode
    command: opencode
    model: openai/gpt-5.4-mini
    capabilities:
      native_subagents: true
      rules: true
      skills: true
      mcp_servers: true
      tools: [read, list, grep, glob, bash, edit, write]
      filesystem: [read-only, workspace-write]
      network: [inherit]
      output_formats: [text, json]
`,
    ".pipeline/profiles.yaml": `
version: 1
profiles:
  orchestrator:
    runner: local
    instructions: { inline: Orchestrate }
  moka-researcher:
    runner: local
    instructions: { inline: Research }
  moka-code-writer:
    runner: local
    instructions: { inline: Implement }
  moka-opencode-code-writer:
    runner: opencode
    model: openai/gpt-5.4-mini
    instructions: { inline: Implement with OpenCode }
    tools: [read, list, grep, glob, bash, edit, write]
    filesystem: { mode: workspace-write }
    network: { mode: inherit }
  moka-verifier:
    runner: local
    instructions: { inline: Verify }
  moka-learner:
    runner: local
    instructions: { inline: Learn }
  moka-thermo-nuclear-reviewer:
    runner: local
    instructions: { inline: Review }
  moka-schedule-planner:
    runner: local
    instructions: { inline: Plan schedule }
`,
    ".pipeline/pipeline.yaml": `
version: 1
default_workflow: inspect
entrypoints:
  execute:
    schedule: execute-schedule
    description: Generated execute schedule
  inspect:
    workflow: inspect
    description: Inspect static workflow
orchestrator:
  profile: orchestrator
schedules:
  execute-schedule:
    baseline: execute
    planner_profile: moka-schedule-planner
workflows:
  inspect:
    nodes:
      - id: inspect
        kind: command
        command: [inspect-bin]
`,
  });
}

function writeMalformedCliConfig(root: string): void {
  writeProjectFileSet(root, {
    ".pipeline/runners.yaml": `
version: 1
runners:
  local:
    type: command
    command: node
    capabilities:
      native_subagents: false
      output_formats: [text]
`,
    ".pipeline/profiles.yaml": `
version: 1
profiles:
  orchestrator:
    runner: local
    instructions: { inline: Orchestrate }
`,
    ".pipeline/pipeline.yaml": "version: [\n",
  });
}

function writeCliValidateLintConfig(
  root: string,
  options: {
    pipeline?: string;
    profiles?: string;
  } = {}
): void {
  writeProjectFileSet(root, {
    ".pipeline/runners.yaml": `
version: 1
runners:
  local:
    type: command
    command: node
    capabilities:
      native_subagents: false
      output_formats: [text, json_schema]
      skills: true
`,
    ".pipeline/profiles.yaml":
      options.profiles ??
      `
version: 1
skills:
  present:
    path: .agents/skills/present/SKILL.md
profiles:
  orchestrator:
    runner: local
    instructions:
      path: .pipeline/prompts/orchestrator.md
    skills: [present]
    output:
      format: json_schema
      schema_path: .pipeline/schemas/orchestrator.schema.json
`,
    ".pipeline/pipeline.yaml":
      options.pipeline ??
      `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: task
        kind: command
        command: [node, --version]
`,
    ".agents/skills/present/SKILL.md": `
---
name: present
---

# Present
`,
    ".pipeline/prompts/orchestrator.md": "Orchestrate\n",
    ".pipeline/schemas/orchestrator.schema.json": `{"type":"object"}\n`,
  });
}

function writeProjectFileSet(
  root: string,
  files: Record<string, string>
): void {
  for (const [path, content] of Object.entries(files)) {
    writeCliProjectFile(root, path, content.trimStart());
  }
}

function mockToolHiveWorkloads(names: string[]): void {
  mockExeca.mockImplementation(((
    command: string,
    args?: string[],
    options?: { cwd?: string; env?: Record<string, string> }
  ) => {
    const result = toolHiveListResult(command, args, names);
    writeHookResult(command, options);
    installSkillsForCommand(command, args, options);
    return Promise.resolve(result ?? emptyExecaResult()) as any;
  }) as any);
}

function toolHiveListResult(
  command: string,
  args: string[] | undefined,
  names: string[]
): { exitCode: number; stderr: string; stdout: string } | undefined {
  return isToolHiveListCommand(command, args)
    ? {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify(names.map(toolHiveWorkload)),
      }
    : undefined;
}

function isToolHiveListCommand(
  command: string,
  args: string[] | undefined
): boolean {
  return (
    command === "thv" &&
    Array.isArray(args) &&
    args.includes("list") &&
    args.includes("--format") &&
    args.includes("json")
  );
}

function toolHiveWorkload(name: string): Record<string, string> {
  return {
    group: "default",
    name,
    status: "running",
    transport_type: "streamable-http",
    url: `http://127.0.0.1/${name}/mcp/`,
  };
}

function writeHookResult(
  command: string,
  options: { env?: Record<string, string> } | undefined
): void {
  const resultPath = options?.env?.PIPELINE_HOOK_RESULT;
  if (resultPath) {
    writeFileSync(
      resultPath,
      JSON.stringify({ status: "pass", summary: command })
    );
  }
}

function installSkillsForCommand(
  command: string,
  args: string[] | undefined,
  options: { cwd?: string } | undefined
): void {
  if (isSkillsInstallCommand(command, args)) {
    installMockSkills(args, options?.cwd);
  }
}

function isSkillsInstallCommand(
  command: string,
  args: string[] | undefined
): args is string[] {
  return (
    command === "npx" &&
    Array.isArray(args) &&
    args.includes("skills") &&
    args.includes("add")
  );
}

function emptyExecaResult(): {
  exitCode: number;
  stderr: string;
  stdout: string;
} {
  return { exitCode: 0, stderr: "", stdout: "" };
}

const COMPLETE_TOOLHIVE_WORKLOADS = [
  "backlog",
  "context7",
  "oisin-pipeline-fallow",
  "playwright",
  "oisin-pipeline-qdrant",
  "serena",
  "uidotsh",
];

function writeThermoNuclearReviewValidateFixture(
  root: string,
  options: { includeSkill: boolean }
): void {
  writeProjectFileSet(root, {
    ".pipeline/runners.yaml": `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      skills: true
      mcp_servers: true
      tools: [read, list, grep, glob, bash]
      filesystem: [read-only]
      network: [inherit]
      output_formats: [text, json_schema]
`,
    ".pipeline/profiles.yaml": `
version: 1
skills:
  thermo-nuclear-code-quality-review:
    path: .agents/skills/thermo-nuclear-code-quality-review/SKILL.md
mcp_gateway:
  provider: toolhive
  mode: local
  url_env: PIPELINE_MCP_GATEWAY_URL
  authorization_env: PIPELINE_MCP_GATEWAY_AUTHORIZATION
profiles:
  orchestrator:
    runner: opencode
    instructions:
      inline: Orchestrate
    filesystem:
      mode: read-only
  moka-thermo-nuclear-reviewer:
    runner: opencode
    instructions:
      path: .agents/skills/thermo-nuclear-code-quality-review/SKILL.md
    skills: [thermo-nuclear-code-quality-review]
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
      allow: ["**/*"]
      deny: ["node_modules/**", "dist/**", ".git/**"]
    network:
      mode: inherit
    output:
      format: json_schema
      schema_path: .pipeline/schemas/review.schema.json
      repair:
        enabled: true
        max_attempts: 1
`,
    ".pipeline/pipeline.yaml": `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: review
        kind: agent
        profile: moka-thermo-nuclear-reviewer
`,
    ".pipeline/schemas/review.schema.json": `{"type":"object"}\n`,
  });

  if (options.includeSkill) {
    writeCliProjectFile(
      root,
      ".agents/skills/thermo-nuclear-code-quality-review/SKILL.md",
      "---\nname: thermo-nuclear-code-quality-review\n---\n\n# Thermo-Nuclear Code Quality Review\n"
    );
  }
}

function execaCommands(): string[] {
  return mockExeca.mock.calls.map(([command]) => String(command));
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

describe("execute", () => {
  it("exports execute and quick functions", async () => {
    const mod = await import("../src/index");
    expect(typeof mod.execute).toBe("function");
    expect(typeof mod.quick).toBe("function");
  });

  it("supports direct init invocation from the package binary", async () => {
    await withDirectInitDir("pipeline-cli-init-", async ({ dir, runCli }) => {
      await runCli(["node", "/repo/node_modules/.bin/oisin-pipeline", "init"]);

      expect(existsSync(join(dir, ".pipeline"))).toBe(false);
      expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
      expect(
        generatedHostFilesExist(dir, [
          ".agents/skills/execute/SKILL.md",
          ".agents/skills/inspect/SKILL.md",
          ".agents/skills/quick/SKILL.md",
          ".opencode/commands/moka-execute.md",
          ".opencode/opencode.json",
        ])
      ).toBe(true);
      expect(mockExeca).toHaveBeenCalledWith(
        "npx",
        [
          "--yes",
          "skills",
          "add",
          "oisin-ee/agent/skills",
          "--agent",
          "opencode",
          "--agent",
          "codex",
          "--agent",
          "claude-code",
          "--skill",
          "*",
          "--yes",
          "--global",
        ],
        expect.objectContaining({ cwd: dir, stdio: "inherit" })
      );
      expect(
        mockExeca.mock.calls.some(
          ([command, args]) =>
            command === "npx" &&
            Array.isArray(args) &&
            args.includes("@uidotsh/install")
        )
      ).toBe(false);
      expect(hasMcpmRegistration()).toBe(false);
    });
  });

  it("does not run MCPM registration during init", async () => {
    await withDirectInitDir(
      "pipeline-cli-init-redacted-mcp-",
      async ({ runCli }) => {
        process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION =
          "Basic test-basic-payload";
        mockExeca.mockImplementation(((
          command: string,
          args?: string[],
          options?: { cwd?: string }
        ) => {
          if (isSkillsInstallCommand(command, args)) {
            installMockSkills(
              args,
              (options as { cwd?: string } | undefined)?.cwd
            );
          }
          return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
        }) as any);

        await runCli([
          "node",
          "/repo/node_modules/.bin/oisin-pipeline",
          "init",
        ]);
        expect(hasMcpmRegistration()).toBe(false);
      }
    );
  });

  it("initializes gateway-only MCP config when gateway authorization is missing", async () => {
    await withCliTempDir(
      "pipeline-cli-init-missing-gateway-auth-",
      async ({ dir, output, runCli }) => {
        delete process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION;

        await runCli([
          "node",
          "/repo/node_modules/.bin/oisin-pipeline",
          "init",
        ]);

        expect(
          mockExeca.mock.calls.some(
            ([command, args]) =>
              command === "uvx" &&
              Array.isArray(args) &&
              args.includes("oisin-pipeline-qdrant")
          )
        ).toBe(false);
        expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
        expect(existsSync(join(dir, ".pipeline"))).toBe(false);
        const stdout = output();
        expect(stdout).not.toContain("Skipped MCPM registration");
        expect(stdout).not.toContain("PIPELINE_MCP_GATEWAY_AUTHORIZATION");
      }
    );
  });

  it("initializes host resources into PIPELINE_TARGET_PATH", async () => {
    await withCliTempDir("pipeline-cli-install-", async ({ dir, runCli }) => {
      await runCli(["node", "/repo/node_modules/.bin/oisin-pipeline", "init"]);

      expect(
        existsSync(join(dir, ".opencode", "commands", "moka-execute.md"))
      ).toBe(true);
      expect(existsSync(join(dir, ".opencode", "commands", "execute.md"))).toBe(
        false
      );
      expect(
        existsSync(join(dir, ".opencode", "commands", "moka-quick.md"))
      ).toBe(true);
      expect(existsSync(join(dir, ".opencode", "opencode.json"))).toBe(true);
      const opencode = JSON.parse(
        readFileSync(join(dir, ".opencode", "opencode.json"), "utf8")
      );
      expect(opencode.mcp["pipeline-gateway"]).toMatchObject({
        type: "remote",
      });
      expect(opencode.mcp["pipeline-gateway"].url).toBe(
        "https://pipeline-mcp.momokaya.ee/mcp/"
      );
    });
  });

  it("installs agent hooks from the consolidated private agent repository", async () => {
    await withCliTempDir(
      "pipeline-cli-hooks-",
      async ({ dir, output, runCli }) => {
        await runCli([
          "node",
          "/repo/node_modules/.bin/oisin-pipeline",
          "init",
        ]);

        expect(readFileSync(join(dir, ".claude/hooks/check.sh"), "utf8")).toBe(
          "#!/bin/sh\necho claude\n"
        );
        expect(readFileSync(join(dir, ".codex/hooks/check.sh"), "utf8")).toBe(
          "#!/bin/sh\necho codex\n"
        );
        expect(
          readFileSync(join(dir, ".opencode/plugin/agent-hooks.ts"), "utf8")
        ).toContain("AgentHooks");
        expect(output()).toContain("generated .claude/hooks/check.sh");
        expect(mockExeca).toHaveBeenCalledWith(
          "gh",
          [
            "repo",
            "clone",
            "oisin-ee/agent",
            expect.any(String),
            "--",
            "--depth=1",
          ],
          expect.objectContaining({ stdio: "inherit" })
        );
      }
    );
  });

  it("does not expose a hook source override flag", async () => {
    const { runCli } = await import("../src/index");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(
        runCli([
          "node",
          "/repo/node_modules/.bin/oisin-pipeline",
          "init",
          "--help",
        ])
      ).rejects.toThrow("outputHelp");
      expect(spyOutput(log)).not.toContain("--source");
    } finally {
      log.mockRestore();
    }
  });

  it("detects relative Node entrypoint paths as CLI executions", async () => {
    const { isCliEntrypoint } = await import("../src/index");
    const sourcePath = fileURLToPath(
      new URL("../src/index.ts", import.meta.url)
    );

    expect(isCliEntrypoint(["node", relative(process.cwd(), sourcePath)])).toBe(
      true
    );
  });

  it("declares installable binaries and typed subpath exports", () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8")
    ) as {
      bin?: Record<string, string>;
      exports?: Record<string, unknown>;
    };

    expect(pkg).toMatchObject({
      name: "@oisincoveney/pipeline",
      publishConfig: { access: "public" },
    });
    expect(pkg.bin).toEqual({
      moka: "dist/index.js",
    });
    expect(pkg.exports?.["."]).toEqual({
      import: "./dist/index.js",
      types: "./dist/index.d.ts",
    });
    expect(pkg.exports?.["./pipeline-primitive"]).toBeUndefined();
    expect(pkg.exports?.["./runner"]).toEqual({
      import: "./dist/runner.js",
      types: "./dist/runner.d.ts",
    });
    expect(pkg.exports?.["./config"]).toEqual({
      import: "./dist/config.js",
      types: "./dist/config.d.ts",
    });
    expect(pkg.exports?.["./hooks"]).toEqual({
      import: "./dist/hooks.js",
      types: "./dist/hooks.d.ts",
    });
    expect(pkg.exports?.["./planner"]).toEqual({
      import: "./dist/planning/compile.js",
      types: "./dist/planning/compile.d.ts",
    });
    expect(pkg.exports?.["./runtime"]).toEqual({
      import: "./dist/pipeline-runtime.js",
      types: "./dist/pipeline-runtime.d.ts",
    });
    expect(pkg.exports?.["./runner-command-contract"]).toEqual({
      import: "./dist/runner-command-contract.js",
      types: "./dist/runner-command-contract.d.ts",
    });
  });

  it("throws if no description provided", async () => {
    const { execute } = await import("../src/index");
    await expect(execute("")).rejects.toThrow(DESCRIPTION_RE);
  });

  it("renders local run progress and agent output live to stdout", async () => {
    const { execute } = await import("../src/index");
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const pipelineRunner = vi.fn().mockImplementation(({ reporter }) => {
      reporter?.({
        nodeIds: ["inspect"],
        type: "workflow.start",
        workflowId: "custom",
      });
      reporter?.({
        attempt: 1,
        nodeId: "inspect",
        profile: "moka-inspector",
        runnerId: "opencode",
        type: "node.start",
      });
      reporter?.({
        actor: {
          id: "pipeline.node.run-123.custom.inspect",
          kind: "node",
          systemId: "pipeline.run-123",
        },
        level: "info",
        name: "runtime.state.enter",
        nodeId: "inspect",
        summary:
          "node actor pipeline.node.run-123.custom.inspect entered running",
        type: "runtime.observability",
        workflowId: "custom",
      });
      reporter?.({
        attempt: 1,
        format: "text",
        nodeId: "inspect",
        output: "live agent line",
        profile: "moka-inspector",
        type: "node.output.recorded",
      });
      reporter?.({
        gateId: "acceptance",
        kind: "verdict",
        nodeId: "inspect",
        type: "gate.start",
      });
      reporter?.({
        evidence: ["acceptance evidence line"],
        gateId: "acceptance",
        kind: "verdict",
        nodeId: "inspect",
        passed: true,
        reason: "approved",
        type: "gate.finish",
      });
      reporter?.({
        attempt: 1,
        exitCode: 0,
        nodeId: "inspect",
        status: "passed",
        type: "node.finish",
      });
      reporter?.({
        outcome: "PASS",
        type: "workflow.finish",
        workflowId: "custom",
      });
      return Promise.resolve({
        agentInvocations: [],
        outcome: "PASS",
        failureDetails: [],
        gates: [],
        hookFailures: [],
        nodes: [
          {
            attempts: 1,
            evidence: [],
            exitCode: 0,
            nodeId: "inspect",
            output: "repo report",
            status: "passed",
          },
        ],
        plan: {
          workflowId: "custom",
          parallelBatches: [],
          topologicalOrder: [],
        },
      });
    });

    let finalOutput = "";
    let stderrOutput = "";
    try {
      await execute("PIPE-42 trivial NOOP", {
        pipelineRunner,
        workflow: "custom",
      });
    } finally {
      finalOutput = log.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      stderrOutput = error.mock.calls
        .map(([message]) => String(message))
        .join("\n");
      error.mockRestore();
      log.mockRestore();
    }

    expect(pipelineRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        entrypoint: undefined,
        reporter: expect.any(Function),
        task: "PIPE-42 trivial NOOP",
        workflowId: "custom",
        worktreePath: process.cwd(),
      })
    );
    expect(stderrOutput).toBe("");
    expect(finalOutput).toContain("Pipeline starting: custom (inspect)");
    expect(finalOutput).toContain(
      "Node starting: inspect runner=opencode profile=moka-inspector attempt=1"
    );
    expect(finalOutput).toContain(
      "Runtime observed: runtime.state.enter - node actor pipeline.node.run-123.custom.inspect entered running"
    );
    expect(finalOutput).toContain("live agent line");
    expect(finalOutput).toContain("Gate passed: inspect/acceptance");
    expect(finalOutput).toContain("attempt=1");
    expect(finalOutput).toContain("acceptance evidence line");
    expect(finalOutput).toContain("Node finished: inspect passed exit=0");
    expect(finalOutput).toContain("Pipeline finished: custom PASS");
    expect(finalOutput.indexOf("live agent line")).toBeLessThan(
      finalOutput.indexOf("Pipeline complete: PASS")
    );
    expect(finalOutput).toContain("Node outputs:");
    expect(finalOutput).toContain("repo report");
  });

  it("passes entrypoint ids through the CLI runner", async () => {
    const { execute } = await import("../src/index");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const pipelineRunner = vi.fn().mockResolvedValue({
      agentInvocations: [],
      failureDetails: [],
      gates: [],
      hookFailures: [],
      nodes: [],
      outcome: "PASS",
      plan: {
        workflowId: "default",
        parallelBatches: [],
        topologicalOrder: [],
      },
    });

    try {
      await execute("ship", { entrypoint: "quick", pipelineRunner });
    } finally {
      log.mockRestore();
      error.mockRestore();
    }

    expect(pipelineRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        entrypoint: "quick",
        task: "ship",
      })
    );
  });

  it("generates and executes schedule artifacts for scheduled execute entrypoints", async () => {
    await withCliTempDir(
      "pipeline-cli-schedule-plan-",
      async ({ dir, output, runCli }) => {
        writeScheduledCliConfig(dir);
        process.env.PIPELINE_TEST_COMMAND = "test-bin";

        await runCli([
          "node",
          "/repo/node_modules/.bin/oisin-pipeline",
          "run",
          "--entrypoint",
          "execute",
          "ship",
          "it",
        ]);

        const stdout = output();
        expect(stdout).toContain("Schedule generated:");
        expect(stdout).not.toContain("Run after approval:");
        expect(stdout).toMatch(SCHEDULE_RUN_WORKFLOW_RE);
        expect(execaCommands()).toContain("opencode");
        expect(stdout).toMatch(SCHEDULE_PATH_RE);
        expect(existsSync(join(dir, ".pipeline", "runs"))).toBe(true);
      }
    );
  });

  it("executes a schedule artifact via run --schedule", async () => {
    await withCliTempDir(
      "pipeline-cli-schedule-run-",
      async ({ dir, output, runCli }) => {
        writeScheduledCliConfig(dir);
        const schedulePath = join(dir, "approved-schedule.yaml");
        writeFileSync(
          schedulePath,
          `
version: 1
kind: pipeline-schedule
schedule_id: approved-a
source_entrypoint: execute
task: Ship it
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: scheduled
        kind: command
        command: [node, -e, "console.log('scheduled')"]
        task_context:
          id: PC-37.2
          title: Build API endpoint
          description: Build the console API endpoint.
          acceptance_criteria:
            - id: "1"
              text: Endpoint validates runner events.
`
        );

        await runCli([
          "node",
          "/repo/node_modules/.bin/oisin-pipeline",
          "run",
          "--schedule",
          schedulePath,
          "Ship",
          "it",
        ]);

        expect(output()).toContain("Workflow: schedule-approved-a-root");
      }
    );
  });

  it("executes package-backed schedule agents through CLI subprocesses", async () => {
    const stub = await startOpencodeStub();
    const originalServerUrl = process.env.OPENCODE_SERVER_URL;
    process.env.OPENCODE_SERVER_URL = stub.url;
    try {
      await withCliTempDir(
        "pipeline-cli-schedule-opencode-",
        async ({ dir, output, runCli }) => {
          const schedulePath = join(dir, "approved-opencode-schedule.yaml");
          writeFileSync(
            schedulePath,
            `
version: 1
kind: pipeline-schedule
schedule_id: approved-opencode
source_entrypoint: execute
task: Ship it with OpenCode
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: implement
        kind: agent
        profile: moka-code-writer
`
          );

          await runCli([
            "node",
            "/repo/node_modules/.bin/oisin-pipeline",
            "run",
            "--schedule",
            schedulePath,
            "Ship",
            "it",
          ]);

          // With the PIPE-73 SDK transport the executor uses the opencode serve
          // API rather than execa. Verify the stub was invoked (at least one
          // session.prompt call reached it) and the workflow ran to completion.
          expect(stub.promptBodies.length).toBeGreaterThan(0);
          // The moka-code-writer profile does not declare a host_model, so no
          // model field is forwarded in the prompt body.
          expect(stub.promptBodies[0]).not.toHaveProperty("model");
          expect(output()).toContain(
            "Workflow: schedule-approved-opencode-root"
          );
        }
      );
    } finally {
      restoreEnv("OPENCODE_SERVER_URL", originalServerUrl);
      await stub.stop();
    }
  });

  it("validates and explains a schedule artifact", async () => {
    await withCliTempDir(
      "pipeline-cli-schedule-inspect-",
      async ({ dir, output, runCli }) => {
        writeScheduledCliConfig(dir);
        const schedulePath = join(dir, "approved-schedule.yaml");
        writeFileSync(
          schedulePath,
          `
version: 1
kind: pipeline-schedule
schedule_id: approved-b
source_entrypoint: execute
task: Inspect it
generated_at: 2026-06-03T12:00:00.000Z
root_workflow: root
workflows:
  root:
    nodes:
      - id: scheduled
        kind: command
        command: [node, -e, "console.log('scheduled')"]
`
        );

        await runCli([
          "node",
          "/repo/node_modules/.bin/oisin-pipeline",
          "validate",
          "--schedule",
          schedulePath,
        ]);
        await runCli([
          "node",
          "/repo/node_modules/.bin/oisin-pipeline",
          "explain-plan",
          "--schedule",
          schedulePath,
        ]);

        const stdout = output();
        expect(stdout).toContain("OK: schedule-approved-b-root (1 nodes)");
        expect(stdout).toContain("Workflow: schedule-approved-b-root");
        expect(stdout).toContain("- scheduled kind=command needs=none");
        expect(stdout).not.toContain("Unrecognized key: task_context");
        expect(execaCommands()).toEqual([]);
      }
    );
  });

  it("dispatches package entrypoint subcommands from package config", async () => {
    const stub = await startOpencodeStub();
    const originalServerUrl = process.env.OPENCODE_SERVER_URL;
    process.env.OPENCODE_SERVER_URL = stub.url;
    try {
      await withCliTempDir("pipeline-cli-entrypoint-", async ({ runCli }) => {
        await runCli([
          "node",
          "/repo/node_modules/.bin/oisin-pipeline",
          "inspect",
          "ship",
          "it",
        ]);

        // With the PIPE-73 SDK transport the executor calls session.prompt
        // instead of execa("opencode"). Verify the stub received a prompt
        // carrying the base model declared on moka-inspector (openai/gpt-5.5)
        // and its reasoning effort applied as the model variant.
        expect(stub.promptBodies.length).toBeGreaterThan(0);
        expect(stub.promptBodies[0]).toMatchObject({
          model: { modelID: "gpt-5.5", providerID: "openai" },
          variant: "low",
        });
        // quick-node-bin must not be called regardless of transport.
        expect(execaCommands()).not.toContain("quick-node-bin");
      });
    } finally {
      restoreEnv("OPENCODE_SERVER_URL", originalServerUrl);
      await stub.stop();
    }
  });

  it("makes moka run primary and lists package entrypoint commands after it", async () => {
    await withCliTempDir("pipeline-cli-entrypoint-help-", async () => {
      const { createCliProgram } = await import("../src/index");
      const help = createCliProgram().helpInformation();
      const commandSummaries = topLevelCommandSummaries(help);

      expect(commandSummaries.get("run") ?? "").toMatch(PRIMARY_COMMAND_RE);
      for (const entrypointCommand of ["quick", "execute", "inspect"]) {
        expect(commandSummaries.get(entrypointCommand) ?? "").not.toMatch(
          NON_CANONICAL_ENTRYPOINT_RE
        );
      }
      const commandOrder = [...commandSummaries.keys()];
      const runIndex = commandOrder.indexOf("run");
      expect(runIndex).toBeGreaterThanOrEqual(0);
      expect(commandOrder.indexOf("quick")).toBeGreaterThan(runIndex);
      expect(commandOrder.indexOf("execute")).toBeGreaterThan(runIndex);
      expect(commandOrder.indexOf("inspect")).toBeGreaterThan(runIndex);
      expect(commandOrder.indexOf("submit")).toBeGreaterThan(runIndex);
      expect(help).not.toContain("runner-job");
    });
  });

  it("prints the package version with --version", async () => {
    await withCliTempDir("pipeline-cli-version-", async () => {
      const { createCliProgram } = await import("../src/index");
      const program = createCliProgram();
      let stdout = "";
      program.configureOutput({
        writeErr: (chunk) => {
          throw new Error(chunk);
        },
        writeOut: (chunk) => {
          stdout += chunk;
        },
      });

      await expect(
        program.parseAsync(
          ["node", "/repo/node_modules/.bin/moka", "--version"],
          {
            from: "node",
          }
        )
      ).rejects.toMatchObject({ code: "commander.version", exitCode: 0 });

      expect(stdout.trim()).toBe(readPackageVersion());
    });
  });

  it("describes package-owned config as the runtime source in CLI help", async () => {
    await withCliTempDir("pipeline-cli-package-help-", async () => {
      const { createCliProgram } = await import("../src/index");
      const help = createCliProgram().helpInformation();

      expect(help.replace(/\s+/g, " ")).toContain(
        "package-owned @oisincoveney/pipeline config"
      );
      expect(help).not.toContain(".pipeline/pipeline.yaml");
      expect(help).not.toMatch(PIPELINE_YAML_SOURCE_RE);
    });
  });

  it("registers moka submit as the graph submission command", async () => {
    await withCliTempDir("pipeline-cli-moka-submit-", async () => {
      const { createCliProgram } = await import("../src/index");
      const program = createCliProgram();
      const k8sRun = program.commands.find(
        (command) => command.name() === "k8s-run"
      );
      const submitCmd = program.commands.find(
        (command) => command.name() === "submit"
      );

      expect(k8sRun).toBeUndefined();
      expect(
        program.commands.find((command) => command.name() === "quick")
      ).toBeDefined();
      expect(
        program.commands.find((command) => command.name() === "execute")
      ).toBeDefined();
      const help = submitCmd?.helpInformation() ?? "";
      expect(help).not.toContain("--local");
      expect(help).toContain("--quick");
      expect(help).toContain("--schedule <path>");
      expect(help).toContain("--command");
      expect(help).toContain("--event-url <url>");
    });
  });

  it("exposes explicit argv submission through moka submit --command", async () => {
    await withCliTempDir("pipeline-cli-moka-submit-command-", async () => {
      const { createCliProgram } = await import("../src/index");
      const program = createCliProgram();
      const argoCmd = program.commands.find(
        (command) => command.name() === "argo"
      );
      const submitCommand = program.commands.find(
        (command) => command.name() === "submit"
      );

      expect(
        argoCmd?.commands.find((command) => command.name() === "submit-command")
      ).toBeUndefined();
      expect(submitCommand).toBeDefined();
      const help = submitCommand?.helpInformation() ?? "";
      expect(help).toContain("[input...]");
      expect(help).toContain("--event-url <url>");
      expect(help).toContain("--task <text>");
      expect(help).toContain("--command");
      expect(help).not.toContain("command-file");
      expect(help).not.toContain("command-json");
      expect(help).not.toContain("node-id");
    });
  });

  it("does not expose public Argo render commands", async () => {
    await withCliTempDir("pipeline-cli-argo-render-", async () => {
      const { createCliProgram } = await import("../src/index");
      const program = createCliProgram();
      const argoCmd = program.commands.find(
        (command) => command.name() === "argo"
      );

      expect(argoCmd).toBeUndefined();
    });
  });

  it("lets builtin collision commands win over configured entrypoints", async () => {
    await withCliTempDir(
      "pipeline-cli-collision-",
      async ({ dir, output, runCli }) => {
        writeCliEntrypointConfig(dir);

        await runCli([
          "node",
          "/repo/node_modules/.bin/oisin-pipeline",
          "validate",
        ]);

        const stdout = output();
        expect(stdout).toContain("OK: inspect");
        expect(stdout).not.toContain("validate-entrypoint");
        expect(execaCommands()).not.toContain("validate-start-bin");
        expect(execaCommands()).not.toContain("validate-entrypoint-bin");
      }
    );
  });

  it("supports explicit scheduled entrypoint execution via run --entrypoint", async () => {
    await withCliTempDir("pipeline-cli-collision-run-", async ({ runCli }) => {
      process.env.PIPELINE_TEST_COMMAND = "test-bin";

      await runCli([
        "node",
        "/repo/node_modules/.bin/oisin-pipeline",
        "run",
        "--entrypoint",
        "execute",
        "ship",
        "collision",
      ]);

      expect(execaCommands()).toContain("opencode");
    });
  });

  it("keeps init and doctor bootstrap commands reachable without config", async () => {
    const { runCli } = await import("../src/index");
    const initDir = mkdtempSync(join(tmpdir(), "pipeline-cli-bootstrap-init-"));
    const doctorDir = mkdtempSync(
      join(tmpdir(), "pipeline-cli-bootstrap-doctor-")
    );
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const savedHostEnv = redirectHostConfig(initDir);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      process.env.PIPELINE_TARGET_PATH = initDir;
      await runCli(["node", "/repo/node_modules/.bin/oisin-pipeline", "init"]);
      expect(existsSync(join(initDir, ".pipeline"))).toBe(false);

      writeMockSkills(DEFAULT_TEST_SKILLS, doctorDir, [], false);
      process.env.PIPELINE_TARGET_PATH = doctorDir;
      await runCli([
        "node",
        "/repo/node_modules/.bin/oisin-pipeline",
        "doctor",
      ]);
      expect(
        log.mock.calls.map(([message]) => String(message)).join("\n")
      ).toContain("PASS pipeline-config: valid");
    } finally {
      log.mockRestore();
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      restoreHostConfig(savedHostEnv);
      rmSync(initDir, { recursive: true, force: true });
      rmSync(doctorDir, { recursive: true, force: true });
    }
  });

  it("installs the global harness, then verifies it with init --check, without git", async () => {
    const { runCli } = await import("../src/index");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-bootstrap-refresh-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const savedHostEnv: Record<string, string | undefined> = {};

    try {
      process.env.PIPELINE_TARGET_PATH = dir;
      for (const key of [
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "OPENCODE_CONFIG_DIR",
        "GEMINI_CONFIG_DIR",
      ]) {
        savedHostEnv[key] = process.env[key];
      }
      process.env.CLAUDE_CONFIG_DIR = join(dir, ".claude");
      process.env.CODEX_HOME = join(dir, ".codex");
      process.env.OPENCODE_CONFIG_DIR = join(dir, ".opencode");
      process.env.GEMINI_CONFIG_DIR = join(dir, ".gemini");
      mockExeca.mockImplementation(((
        command: string,
        args?: string[],
        options?: { cwd?: string; reject?: boolean }
      ) => {
        if (isSkillsInstallCommand(command, args)) {
          installMockSkills(
            args,
            (options as { cwd?: string } | undefined)?.cwd
          );
        }
        installMockAgentRepoIfRequested(command, args);
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: "true\n" });
      }) as any);

      await runCli(["node", "/repo/node_modules/.bin/oisin-pipeline", "init"]);

      expect(existsSync(join(dir, ".pipeline"))).toBe(false);
      expect(
        existsSync(join(dir, ".opencode", "commands", "moka-execute.md"))
      ).toBe(true);

      // The just-installed harness is current, so init --check passes (no throw).
      await runCli([
        "node",
        "/repo/node_modules/.bin/oisin-pipeline",
        "init",
        "--check",
      ]);

      // Global harness install/verify does not make any git calls.
      expect(mockExeca).not.toHaveBeenCalledWith(
        "git",
        expect.anything(),
        expect.anything()
      );
    } finally {
      for (const [key, value] of Object.entries(savedHostEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      if (originalTargetPath === undefined) {
        delete process.env.PIPELINE_TARGET_PATH;
      } else {
        process.env.PIPELINE_TARGET_PATH = originalTargetPath;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores malformed repo-local pipeline config because package config owns runtime", async () => {
    await withCliTempDir("pipeline-cli-malformed-", async ({ dir, runCli }) => {
      writeMalformedCliConfig(dir);
      process.env.PIPELINE_TEST_COMMAND = "test-bin";
      await expect(executeShipIt(runCli)).resolves.toBeUndefined();
      expect(execaCommands()).toContain("opencode");
    });
  });

  it("runs from package config when execute is invoked without repo pipeline config", async () => {
    await withCliTempDir("pipeline-cli-missing-", async ({ runCli }) => {
      process.env.PIPELINE_TEST_COMMAND = "test-bin";
      await expect(executeShipIt(runCli)).resolves.toBeUndefined();
      expect(execaCommands()).toContain("opencode");
    });
  });

  it("does not repair partial repo-local pipeline files", async () => {
    await withCliTempDir(
      "pipeline-cli-partial-init-",
      async ({ dir, output, runCli }) => {
        writeCliProjectFile(
          dir,
          ".pipeline/pipeline.yaml",
          "version: 1\ndefault_workflow: default\nworkflows: {}\n"
        );

        await runCli([
          "node",
          "/repo/node_modules/.bin/oisin-pipeline",
          "init",
        ]);

        expect(existsSync(join(dir, ".pipeline", "profiles.yaml"))).toBe(false);
        expect(existsSync(join(dir, ".pipeline", "runners.yaml"))).toBe(false);
        expect(output()).toContain(
          "no repo-local pipeline config files were created"
        );
      }
    );
  });

  it("validates and explains the initialized YAML plan", async () => {
    await withCliTempDir("pipeline-cli-plan-", async ({ output, runCli }) => {
      await runCli(["node", "/repo/node_modules/.bin/oisin-pipeline", "init"]);
      await runCli([
        "node",
        "/repo/node_modules/.bin/oisin-pipeline",
        "validate",
      ]);
      await runCli([
        "node",
        "/repo/node_modules/.bin/oisin-pipeline",
        "explain-plan",
      ]);
      await runCli([
        "node",
        "/repo/node_modules/.bin/oisin-pipeline",
        "doctor",
      ]);

      const stdout = output();
      expect(stdout).toContain("OK: inspect");
      expect(stdout).toContain("Workflow: inspect");
      expect(stdout).not.toContain("strategy=");
      expect(stdout).toContain("Doctor: PASS");
    });
  });

  it("validates the package inspect workflow without legacy warnings", async () => {
    await withCliTarget(process.cwd(), async (fixture) => {
      await fixture.runCli([
        "node",
        "/repo/node_modules/.bin/oisin-pipeline",
        "validate",
      ]);
      expect(fixture.stderr()).not.toContain("WARN ");
      expect(fixture.output()).toContain("OK: inspect");
    });
  });

  it("explains the package inspect workflow topology", async () => {
    await withCliTarget(process.cwd(), async (fixture) => {
      await fixture.runCli([
        "node",
        "/repo/node_modules/.bin/oisin-pipeline",
        "explain-plan",
      ]);
      const stdout = fixture.output();
      expect(stdout).toContain("Workflow: inspect");
      expect(stdout).toContain("Batches: [inspect]");
      expect(stdout).toContain("- inspect kind=agent needs=none");
    });
  });

  it("validate ignores repo-local entrypoint collisions because package config owns runtime", async () => {
    await withCliTempDir("pipeline-cli-lint-entrypoint-", async (fixture) => {
      const { stderr, stdout } = await validateCliLintFixture(fixture, {
        pipeline: `
version: 1
default_workflow: default
entrypoints:
  validate:
    workflow: default
    description: Shadow validate
  pipe:
    workflow: default
    description: Shadow pipe
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: task
        kind: command
        command: [node, --version]
`,
      });

      expect(stderr).not.toContain("WARN entrypoint-shadowed");
      expect(stdout).toContain("OK: inspect");
    });
  });

  it("validate ignores repo-local optional asset paths and validates package config", async () => {
    await withCliTempDir(
      "pipeline-cli-lint-missing-",
      async ({ dir, output, runCli, stderr }) => {
        writeCliValidateLintConfig(dir, {
          profiles: `
version: 1
skills:
  missing-skill:
    path: .agents/skills/missing/SKILL.md
profiles:
  orchestrator:
    runner: local
    instructions:
      path: .pipeline/prompts/missing.md
    skills: [missing-skill]
    output:
      format: json_schema
      schema_path: .pipeline/schemas/missing.schema.json
`,
        });

        await runCli([
          "node",
          "/repo/node_modules/.bin/oisin-pipeline",
          "validate",
        ]);

        const stderrOutput = stderr();
        expect(stderrOutput).not.toContain("missing-skill");
        expect(stderrOutput).not.toContain(".pipeline/prompts/missing.md");
        expect(output()).toContain("OK: inspect");
      }
    );
  });

  it("validate does not warn about missing epic-router asset files once the bundle exists", async () => {
    await withCliTempDir(
      "pipeline-cli-lint-epic-router-",
      async ({ dir, output, runCli, stderr }) => {
        writeProjectFileSet(dir, {
          ".pipeline/runners.yaml": `
version: 1
runners:
  opencode:
    type: opencode
    command: opencode
    capabilities:
      native_subagents: true
      rules: true
      skills: true
      mcp_servers: true
      tools: [read, list, grep, glob, bash]
      filesystem: [read-only]
      network: [inherit]
      output_formats: [text, json_schema]
`,
          ".pipeline/profiles.yaml": `
version: 1
mcp_gateway:
  provider: toolhive
  mode: local
  url_env: PIPELINE_MCP_GATEWAY_URL
  authorization_env: PIPELINE_MCP_GATEWAY_AUTHORIZATION
profiles:
  orchestrator:
    runner: opencode
    instructions:
      inline: Orchestrate
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
    network:
      mode: inherit
  moka-epic-router:
    runner: opencode
    instructions:
      path: .pipeline/prompts/epic-router.md
    mcp_servers: [pipeline-gateway]
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
      allow: ["**/*"]
      deny: ["node_modules/**", "dist/**", ".git/**"]
    network:
      mode: inherit
    output:
      format: json_schema
      schema_path: .pipeline/schemas/epic-plan.schema.json
      repair:
        enabled: true
        max_attempts: 1
`,
          ".pipeline/pipeline.yaml": `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: task
        kind: command
        command: [node, --version]
`,
        });
        for (const assetPath of [
          ".pipeline/prompts/epic-router.md",
          ".pipeline/schemas/epic-plan.schema.json",
        ]) {
          const sourcePath = join(process.cwd(), assetPath);
          if (existsSync(sourcePath)) {
            writeCliProjectFile(
              dir,
              assetPath,
              readFileSync(sourcePath, "utf8")
            );
          }
        }

        await runCli([
          "node",
          "/repo/node_modules/.bin/oisin-pipeline",
          "validate",
        ]);

        const stderrOutput = stderr();
        expect(stderrOutput).not.toContain(
          "profiles.moka-epic-router.instructions.path references missing file '.pipeline/prompts/epic-router.md'"
        );
        expect(stderrOutput).not.toContain(
          "profiles.moka-epic-router.output.schema_path references missing file '.pipeline/schemas/epic-plan.schema.json'"
        );
        expect(stderrOutput).not.toContain("WARN missing-file-reference");
        expect(output()).toContain("OK: inspect");
      }
    );
  });

  it("validate --strict ignores repo-local lint warnings and validates package config", async () => {
    await withCliTempDir(
      "pipeline-cli-lint-thermo-review-present-",
      async ({ dir, output, runCli, stderr }) => {
        writeThermoNuclearReviewValidateFixture(dir, { includeSkill: true });

        await runCli([
          "node",
          "/repo/node_modules/.bin/oisin-pipeline",
          "validate",
          "--strict",
        ]);

        const stderrOutput = stderr();
        expect(stderrOutput).not.toContain("WARN missing-file-reference");
        expect(stderrOutput).not.toContain(
          "skills.thermo-nuclear-code-quality-review.path references missing file '.agents/skills/thermo-nuclear-code-quality-review/SKILL.md'"
        );
        expect(stderrOutput).not.toContain(
          "profiles.moka-thermo-nuclear-reviewer.instructions.path references missing file '.agents/skills/thermo-nuclear-code-quality-review/SKILL.md'"
        );
        expect(stderrOutput).not.toContain(
          "profiles.moka-thermo-nuclear-reviewer.output.schema_path references missing file '.pipeline/schemas/review.schema.json'"
        );
        expect(stderrOutput).not.toContain("WARN entrypoint-shadowed");
        expect(output()).toContain("OK: inspect");
      }
    );
  });

  it("validate does not emit repo-local thermo-nuclear review missing-file warnings", async () => {
    await withCliTempDir(
      "pipeline-cli-lint-thermo-review-missing-",
      async ({ dir, output, runCli, stderr }) => {
        writeThermoNuclearReviewValidateFixture(dir, { includeSkill: false });

        await runCli([
          "node",
          "/repo/node_modules/.bin/oisin-pipeline",
          "validate",
        ]);

        const missingFileWarnings = stderr()
          .split("\n")
          .filter((line) => line.includes("WARN missing-file-reference"));
        expect(missingFileWarnings).toEqual([]);
        expect(output()).toContain("OK: inspect");
      }
    );
  });

  it("validate ignores repo-local singleton parallel lint fixtures", async () => {
    await withCliTempDir("pipeline-cli-lint-parallel-", async (fixture) => {
      const { stderr, stdout } = await validateCliLintFixture(fixture, {
        pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: fanout
        kind: parallel
        nodes:
          - id: only
            kind: command
            command: [node, --version]
`,
      });

      expect(stderr).not.toContain("WARN singleton-parallel");
      expect(stdout).toContain("OK: inspect");
    });
  });

  it("validate --strict ignores repo-local lint warnings because package config owns runtime", async () => {
    await withCliTempDir(
      "pipeline-cli-lint-strict-",
      async ({ dir, output, runCli, stderr }) => {
        writeCliValidateLintConfig(dir, {
          pipeline: `
version: 1
default_workflow: default
entrypoints:
  validate:
    workflow: default
    description: Shadow validate
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: task
        kind: command
        command: [node, --version]
`,
        });

        await runCli([
          "node",
          "/repo/node_modules/.bin/oisin-pipeline",
          "validate",
          "--strict",
        ]);

        expect(stderr()).not.toContain("WARN entrypoint-shadowed");
        expect(output()).toContain("OK: inspect");
      }
    );
  });

  it("validate --no-lint skips WARN output and succeeds schema and plan validation only", async () => {
    await withCliTempDir(
      "pipeline-cli-lint-disabled-",
      async ({ dir, output, runCli, stderr }) => {
        writeCliValidateLintConfig(dir, {
          profiles: `
version: 1
skills:
  missing-skill:
    path: .agents/skills/missing/SKILL.md
profiles:
  orchestrator:
    runner: local
    instructions:
      path: .pipeline/prompts/missing.md
    skills: [missing-skill]
    output:
      format: json_schema
      schema_path: .pipeline/schemas/missing.schema.json
`,
        });

        await runCli([
          "node",
          "/repo/node_modules/.bin/oisin-pipeline",
          "validate",
          "--no-lint",
        ]);

        expect(stderr()).not.toContain("WARN ");
        expect(output()).toContain("OK: inspect");
      }
    );
  });

  it("validate --no-lint ignores malformed repo-local schemas and validates package config", async () => {
    await withCliTempDir(
      "pipeline-cli-lint-schema-",
      async ({ dir, runCli, stderr }) => {
        writeMalformedCliConfig(dir);

        await runCli([
          "node",
          "/repo/node_modules/.bin/oisin-pipeline",
          "validate",
          "--strict",
          "--no-lint",
        ]);

        expect(stderr()).not.toContain("WARN ");
      }
    );
  });

  it("doctor reports missing prerequisites", async () => {
    await withCliTempDir("pipeline-cli-doctor-", async ({ dir, runCli }) => {
      const { runDoctor } = await import("../src/index");
      await runCli(["node", "/repo/node_modules/.bin/oisin-pipeline", "init"]);
      mockExeca.mockImplementation(((command: string) => {
        if (command === "opencode") {
          return Promise.reject({ shortMessage: "opencode missing" });
        }
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
      }) as any);

      const result = await runDoctor(dir);

      expect(result.passed).toBe(false);
      expect(result.checks).toContainEqual({
        detail: "opencode missing",
        name: "opencode",
        passed: false,
      });
    });
  });

  it("doctor reports value-free cluster runner prerequisites", async () => {
    const { runCli } = await import("../src/index");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-cluster-doctor-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const originalHome = process.env.HOME;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      writeMockSkills(DEFAULT_TEST_SKILLS, dir, [], false);
      process.env.PIPELINE_TARGET_PATH = dir;
      // Sandbox HOME so loadMokaGlobalConfig() reads from the temp dir (absent →
      // DEFAULT_RESOURCES), not the developer's real ~/.config/moka/config.yaml.
      process.env.HOME = dir;
      mockExeca.mockImplementation(clusterDoctorExecaResult);

      await expect(
        runCli([
          "node",
          "/repo/node_modules/.bin/oisin-pipeline",
          "doctor",
          "--cluster",
          "test-ns",
          "--kube-context",
          "test-context",
        ])
      ).rejects.toThrow("Doctor checks failed.");

      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("FAIL secret/pipeline-runner-event-auth");
      expect(output).toContain(
        "Secret pipeline-runner-event-auth missing in test-ns; expected ExternalSecret pipeline-runner-event-auth to sync it from agent-runtime/pipeline-runner/event-auth"
      );
      expect(output).toContain("FAIL clustersecretstore/openbao");
      expect(output).toContain("OpenBao auth drift");
      expect(output).toContain("FAIL rbac/workflow-create");
      expect(output).not.toContain("super-secret-token");
      expect(kubectlCalls()).toContainEqual([
        "--context",
        "test-context",
        "auth",
        "can-i",
        "create",
        "workflows.argoproj.io",
        "-n",
        "test-ns",
      ]);
      expect(kubectlCalls().flat()).not.toContain("--as");
      expect(kubectlCalls()).toContainEqual([
        "--context",
        "test-context",
        "get",
        "secret",
        "pipeline-runner-event-auth",
        "-n",
        "test-ns",
      ]);
    } finally {
      log.mockRestore();
      restoreEnv("PIPELINE_TARGET_PATH", originalTargetPath);
      restoreEnv("HOME", originalHome);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("doctor reports forbidden cluster resources as inaccessible", async () => {
    const { runCli } = await import("../src/index");
    const dir = mkdtempSync(
      join(tmpdir(), "pipeline-cli-cluster-doctor-forbidden-")
    );
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const originalHome = process.env.HOME;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      writeMockSkills(DEFAULT_TEST_SKILLS, dir, [], false);
      process.env.HOME = dir;
      process.env.PIPELINE_TARGET_PATH = dir;
      mockExeca.mockImplementation(((command: string, args: string[]) => {
        if (command !== "kubectl") {
          return Promise.resolve({ exitCode: 0, stderr: "", stdout: "ok" });
        }
        const kubectlArgs = stripKubectlContext(args);
        if (kubectlArgs.includes("pipeline-runner-event-auth")) {
          return Promise.reject({
            stderr:
              'Error from server (Forbidden): secrets "pipeline-runner-event-auth" is forbidden',
          });
        }
        if (
          kubectlArgs.join(" ") ===
          "auth can-i create workflows.argoproj.io -n test-ns"
        ) {
          return Promise.resolve({ exitCode: 0, stderr: "", stdout: "yes" });
        }
        if (kubectlArgs.includes("-o") && kubectlArgs.includes("json")) {
          return Promise.resolve({
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              status: { conditions: [{ status: "True", type: "Ready" }] },
            }),
          });
        }
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: "present" });
      }) as any);

      await expect(
        runCli([
          "node",
          "/repo/node_modules/.bin/oisin-pipeline",
          "doctor",
          "--cluster",
          "test-ns",
        ])
      ).rejects.toThrow("Doctor checks failed.");

      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("FAIL secret/pipeline-runner-event-auth");
      expect(output).toContain(
        "secret/pipeline-runner-event-auth inaccessible with the current kube identity"
      );
      expect(output).not.toContain(
        "expected ExternalSecret pipeline-runner-event-auth to sync it"
      );
    } finally {
      log.mockRestore();
      restoreEnv("PIPELINE_TARGET_PATH", originalTargetPath);
      restoreEnv("HOME", originalHome);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("doctor uses configured kubeconfig and namespace for cluster checks", async () => {
    const { runCli } = await import("../src/index");
    const dir = mkdtempSync(
      join(tmpdir(), "pipeline-cli-cluster-doctor-kubeconfig-")
    );
    const originalHome = process.env.HOME;
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const configuredKubeconfig = join(dir, "momokaya-agent-restricted.yaml");

    try {
      mkdirSync(join(dir, ".config", "moka"), { recursive: true });
      writeFileSync(
        join(dir, ".config", "moka", "config.yaml"),
        [
          "momokaya:",
          "  kubernetes:",
          `    kubeconfig: ${configuredKubeconfig}`,
          "    namespace: configured-ns",
          "  submit:",
          "    brokerAuth:",
          "      secretName: broker-api-key",
          "    eventAuthSecretKey: EVENT_AUTH_TOKEN_KEY",
          "    eventAuthSecretName: event-auth-secret",
          "    eventUrl: https://console.example.test/api/pipeline/runner-events",
          "    gitCredentialsSecretName: git-credentials-secret",
          "    githubAuthSecretName: github-auth-secret",
          "    imagePullSecretName: image-pull-secret",
          "    serviceAccountName: configured-runner",
          "",
        ].join("\n")
      );
      writeMockSkills(DEFAULT_TEST_SKILLS, dir, [], false);
      process.env.HOME = dir;
      process.env.PIPELINE_TARGET_PATH = dir;
      mockExeca.mockImplementation(((command: string, args: string[]) => {
        if (command !== "kubectl") {
          return Promise.resolve({ exitCode: 0, stderr: "", stdout: "ok" });
        }
        const kubectlArgs = stripKubectlContext(args);
        if (
          kubectlArgs.join(" ") ===
          "auth can-i create workflows.argoproj.io -n configured-ns"
        ) {
          return Promise.resolve({ exitCode: 0, stderr: "", stdout: "yes" });
        }
        if (kubectlArgs.includes("-o") && kubectlArgs.includes("json")) {
          return Promise.resolve({
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              status: { conditions: [{ status: "True", type: "Ready" }] },
            }),
          });
        }
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: "present" });
      }) as any);

      await runCli([
        "node",
        "/repo/node_modules/.bin/oisin-pipeline",
        "doctor",
        "--cluster",
      ]);

      expect(kubectlCalls()).toContainEqual([
        "get",
        "namespace",
        "configured-ns",
      ]);
      for (const [command, , options] of mockExeca.mock.calls) {
        if (command === "kubectl") {
          expect(options).toMatchObject({
            env: { KUBECONFIG: configuredKubeconfig },
          });
        }
      }
    } finally {
      restoreEnv("HOME", originalHome);
      restoreEnv("PIPELINE_TARGET_PATH", originalTargetPath);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("configures project host MCP config as gateway-only with backups", async () => {
    const { runCli } = await import("../src/index");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-gateway-configure-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const originalGatewayUrl = process.env.PIPELINE_MCP_GATEWAY_URL;
    const originalGatewayToken = process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION;
    const savedHostEnv = redirectHostConfig(dir);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      process.env.PIPELINE_TARGET_PATH = dir;
      process.env.PIPELINE_MCP_GATEWAY_URL = "https://gateway.example/mcp";
      process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION = "Basic test-token";
      await runCli(["node", "/repo/node_modules/.bin/oisin-pipeline", "init"]);
      mkdirSync(join(dir, ".opencode"), { recursive: true });
      writeFileSync(
        join(dir, ".opencode/opencode.json"),
        JSON.stringify({ mcp: { legacy: { type: "local" } } })
      );

      await runCli([
        "node",
        "/repo/node_modules/.bin/oisin-pipeline",
        "mcp",
        "gateway",
        "configure-host",
      ]);

      const opencode = JSON.parse(
        readFileSync(join(dir, ".opencode/opencode.json"), "utf8")
      );
      expect(opencode.mcp["pipeline-gateway"]).toMatchObject({
        enabled: true,
        oauth: false,
        type: "remote",
        url: "https://gateway.example/mcp",
      });
      expect(opencode.mcp.legacy).toBeUndefined();
      const claude = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
      expect(claude.mcpServers["pipeline-gateway"]).toMatchObject({
        type: "http",
        url: "https://gateway.example/mcp",
      });
      expect(claude.mcpServers["pipeline-gateway"].headers).toEqual({
        Authorization: CLAUDE_GATEWAY_AUTH_HEADER,
      });
      const codex = readFileSync(join(dir, ".codex/config.toml"), "utf8");
      expect(codex).toContain("[mcp_servers.pipeline-gateway]");
      expect(codex).toContain('url = "https://gateway.example/mcp"');
      expect(codex).toContain(
        "[mcp_servers.pipeline-gateway.env_http_headers]"
      );
      expect(codex).toContain(
        'Authorization = "PIPELINE_MCP_GATEWAY_AUTHORIZATION"'
      );
      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain(".opencode/opencode.json");
      expect(output).toContain(".mcp.json");
      expect(output).toContain(".codex/config.toml");
      expect(output).toContain("backup=");
    } finally {
      log.mockRestore();
      restoreEnv("PIPELINE_TARGET_PATH", originalTargetPath);
      restoreEnv("PIPELINE_MCP_GATEWAY_URL", originalGatewayUrl);
      restoreEnv("PIPELINE_MCP_GATEWAY_AUTHORIZATION", originalGatewayToken);
      restoreHostConfig(savedHostEnv);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gateway doctor detects legacy direct MCP config", async () => {
    const { runCli } = await import("../src/index");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-gateway-doctor-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const originalGatewayUrl = process.env.PIPELINE_MCP_GATEWAY_URL;
    const originalGatewayToken = process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION;
    const originalFetch = global.fetch;
    const savedHostEnv = redirectHostConfig(dir);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      process.env.PIPELINE_TARGET_PATH = dir;
      process.env.PIPELINE_MCP_GATEWAY_URL = "http://127.0.0.1:4483/mcp";
      process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION = "Basic test-token";
      global.fetch = vi.fn().mockResolvedValue({ status: 200 }) as any;
      await runCli(["node", "/repo/node_modules/.bin/oisin-pipeline", "init"]);
      writeFileSync(
        join(dir, ".mcp.json"),
        JSON.stringify({ mcpServers: { legacy: { command: "uvx" } } })
      );

      const gatewayDoctor = runGatewayDoctor(runCli);
      await expect(gatewayDoctor).rejects.toThrow(
        "MCP gateway doctor checks failed."
      );

      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("legacy-direct-mcp");
      expect(output).toContain(".mcp.json");
    } finally {
      log.mockRestore();
      global.fetch = originalFetch;
      restoreEnv("PIPELINE_TARGET_PATH", originalTargetPath);
      restoreEnv("PIPELINE_MCP_GATEWAY_URL", originalGatewayUrl);
      restoreEnv("PIPELINE_MCP_GATEWAY_AUTHORIZATION", originalGatewayToken);
      restoreHostConfig(savedHostEnv);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gateway doctor fails when required upstream tools are missing", async () => {
    const { runCli } = await import("../src/index");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-gateway-tools-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const originalGatewayUrl = process.env.PIPELINE_MCP_GATEWAY_URL;
    const originalGatewayToken = process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION;
    const originalFetch = global.fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      process.env.PIPELINE_TARGET_PATH = dir;
      process.env.PIPELINE_MCP_GATEWAY_URL = "http://127.0.0.1:4483/mcp";
      process.env.PIPELINE_MCP_GATEWAY_AUTHORIZATION = "Basic test-token";
      global.fetch = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/health")) {
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(
          Response.json({
            jsonrpc: "2.0",
            id: 2,
            result: {
              tools: [{ name: "context7_query_docs" }],
            },
          })
        );
      });

      await expect(runGatewayDoctor(runCli)).rejects.toThrow(
        "MCP gateway doctor checks failed."
      );

      const outputLines = log.mock.calls.flat().map((value) => String(value));
      expect(outputLines.join("\n")).toContain("gateway-required-tools");
      expect(outputLines.join("\n")).toContain("missing:");
      expect(outputLines.join("\n")).toContain("backlog");
    } finally {
      log.mockRestore();
      global.fetch = originalFetch;
      restoreEnv("PIPELINE_TARGET_PATH", originalTargetPath);
      restoreEnv("PIPELINE_MCP_GATEWAY_URL", originalGatewayUrl);
      restoreEnv("PIPELINE_MCP_GATEWAY_AUTHORIZATION", originalGatewayToken);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconciles the current workspace into a complete ToolHive vMCP inventory", async () => {
    const { runCli } = await import("../src/index");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-gateway-reconcile-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      mockToolHiveWorkloads(COMPLETE_TOOLHIVE_WORKLOADS);
      process.env.PIPELINE_TARGET_PATH = dir;
      await prepareGatewayWorkspace(runCli, dir);

      await runCli([
        "node",
        "/repo/node_modules/.bin/oisin-pipeline",
        "mcp",
        "gateway",
        "reconcile",
      ]);

      expect(mockExeca).toHaveBeenCalledWith(
        "thv",
        expect.arrayContaining(["vmcp", "validate"]),
        expect.objectContaining({ cwd: dir })
      );
      const applyCall = mockExeca.mock.calls.find(
        ([command, args]) =>
          command === "thv" && Array.isArray(args) && args.includes("validate")
      );
      expect(applyCall).toBeDefined();
      const args = applyCall?.[1];
      expect(Array.isArray(args)).toBe(true);
      const filePath = Array.isArray(args) ? args.at(-1) : undefined;
      expect(filePath).toBeTruthy();
      const rendered = readFileSync(filePath as string, "utf8");
      expect(rendered).toContain("name: backlog");
      expect(rendered).toContain("name: context7");
      expect(rendered).toContain("name: fallow");
      expect(rendered).toContain("name: playwright");
      expect(rendered).toContain("name: qdrant");
      expect(rendered).toContain(
        "url: http://127.0.0.1/oisin-pipeline-qdrant/mcp/"
      );
      expect(rendered).toContain("name: serena");
      expect(rendered).toContain("name: uidotsh");
      expect(rendered).toContain("groupRef: default");

      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("workspace=");
      expect(output).toContain(dir);
      expect(output).not.toMatch(NO_REPO_COPY_RE);
    } finally {
      log.mockRestore();
      restoreEnv("PIPELINE_TARGET_PATH", originalTargetPath);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts local gateway with ToolHive vMCP for local mode", async () => {
    const { runCli } = await import("../src/index");
    const dir = mkdtempSync(join(tmpdir(), "pipeline-cli-gateway-start-"));
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const savedHostEnv = redirectHostConfig(dir);

    try {
      mockToolHiveWorkloads(COMPLETE_TOOLHIVE_WORKLOADS);
      process.env.PIPELINE_TARGET_PATH = dir;
      await prepareGatewayWorkspace(runCli, dir, { init: true });
      await runCli([
        "node",
        "/repo/node_modules/.bin/oisin-pipeline",
        "mcp",
        "gateway",
        "local-start",
      ]);

      expect(mockExeca).toHaveBeenCalledWith(
        "thv",
        expect.arrayContaining(["vmcp", "validate"]),
        expect.objectContaining({ cwd: dir })
      );
      const validateCall = mockExeca.mock.calls.find(
        ([command, args]) =>
          command === "thv" && Array.isArray(args) && args.includes("validate")
      );
      const validateArgs = validateCall?.[1];
      expect(Array.isArray(validateArgs)).toBe(true);
      const configPath = Array.isArray(validateArgs)
        ? validateArgs.at(-1)
        : undefined;
      expect(configPath).toBe(join(dir, ".pipeline/mcp-gateway/vmcp.yaml"));

      expect(mockExeca).toHaveBeenCalledWith(
        "thv",
        [
          "vmcp",
          "serve",
          "--config",
          join(dir, ".pipeline/mcp-gateway/vmcp.yaml"),
          "--host",
          "127.0.0.1",
          "--port",
          "4483",
        ],
        expect.objectContaining({ cwd: dir })
      );
    } finally {
      restoreEnv("PIPELINE_TARGET_PATH", originalTargetPath);
      restoreHostConfig(savedHostEnv);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses local gateway startup when required ToolHive workloads are missing", async () => {
    const { runCli } = await import("../src/index");
    const dir = mkdtempSync(
      join(tmpdir(), "pipeline-cli-gateway-start-missing-")
    );
    const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
    const savedHostEnv = redirectHostConfig(dir);

    try {
      mockToolHiveWorkloads(["oisin-pipeline-qdrant"]);
      process.env.PIPELINE_TARGET_PATH = dir;
      await prepareGatewayWorkspace(runCli, dir, { init: true });

      await expect(
        runCli([
          "node",
          "/repo/node_modules/.bin/oisin-pipeline",
          "mcp",
          "gateway",
          "local-start",
        ])
      ).rejects.toThrow(MISSING_TOOLHIVE_WORKLOAD_RE);

      expect(
        mockExeca.mock.calls.some(
          ([command, args]) =>
            command === "thv" && Array.isArray(args) && args.includes("serve")
        )
      ).toBe(false);
    } finally {
      restoreEnv("PIPELINE_TARGET_PATH", originalTargetPath);
      restoreHostConfig(savedHostEnv);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces YAML runtime failures from pipe", async () => {
    const { execute } = await import("../src/index");

    const pipelineRunner = vi.fn().mockResolvedValue({
      agentInvocations: [],
      failureDetails: [
        {
          evidence: ["agent boundary node=verify", "missing file"],
          gate: "artifact",
          nodeId: "verify",
          reason: "missing artifact",
        },
      ],
      gates: [],
      hookFailures: [],
      nodes: [
        {
          attempts: 1,
          evidence: ["agent boundary node=verify", "missing file"],
          exitCode: 1,
          nodeId: "verify",
          output: "raw verifier output",
          status: "failed",
        },
      ],
      outcome: "FAIL",
      plan: {
        workflowId: "default",
        parallelBatches: [],
        topologicalOrder: [],
      },
    });

    await expect(
      execute("ship it", { pipelineRunner, workflow: "default" })
    ).rejects.toThrow(FAILURE_DETAILS_RE);
  });
});
