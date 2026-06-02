import { readFileSync } from "node:fs";
import { execa } from "execa";
import { z } from "zod";

export interface PipelineMcpInstallSpec {
  args?: string[];
  catalog?: string;
  command?: string;
  env?: Record<string, string>;
  headers?: Record<string, PipelineMcpHeaderValue>;
  name: string;
  optionalRegistration?: boolean;
  transport: "remote" | "stdio";
  url?: string;
}

export interface PipelineMcpHeaderSource {
  env: string;
  prefix?: string;
  suffix?: string;
}

export type PipelineMcpHeaderValue = string | PipelineMcpHeaderValueSpec;

export interface PipelineMcpHeaderValueSpec {
  sources: PipelineMcpHeaderSource[];
}

export interface PipelineMcpSkippedRegistration {
  missingEnv: string[];
  name: string;
  reason: string;
}

export interface PipelineMcpInstallResult {
  skipped: PipelineMcpSkippedRegistration[];
}

export type PipelineMcpInstaller = (
  specs: PipelineMcpInstallSpec[],
  cwd: string
) => Promise<PipelineMcpInstallResult | undefined>;

export class PipelineMcpInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineMcpInstallError";
  }
}

class PipelineMcpMissingCredentialError extends PipelineMcpInstallError {
  headerName: string;
  missingEnv: string[];
  serverName: string;

  constructor(serverName: string, headerName: string, missingEnv: string[]) {
    super(
      [
        `MCP server ${serverName} requires ${headerName} credentials before it can be registered.`,
        `Set ${missingEnv.join(" or ")} and re-run pipeline init.`,
      ].join("\n")
    );
    this.name = "PipelineMcpMissingCredentialError";
    this.serverName = serverName;
    this.headerName = headerName;
    this.missingEnv = missingEnv;
  }
}

export class PipelineDefaultManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineDefaultManifestError";
  }
}

export const DEFAULT_MCPM_COMMAND = "uvx";
export const DEFAULT_MCPM_ARGS = ["--python", "3.12", "mcpm"];
const DEFAULT_INSTALL_MANIFEST_URL = new URL(
  "../../defaults/install-manifest.json",
  import.meta.url
);

const pipelineMcpHeaderSourceSchema = z
  .object({
    env: z.string().min(1),
    prefix: z.string().optional(),
    suffix: z.string().optional(),
  })
  .strict();

const pipelineMcpHeaderValueSchema = z.union([
  z.string(),
  z
    .object({
      sources: z.array(pipelineMcpHeaderSourceSchema).min(1),
    })
    .strict(),
]);

export const pipelineMcpInstallSpecSchema = z
  .object({
    args: z.array(z.string()).optional(),
    catalog: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), pipelineMcpHeaderValueSchema).optional(),
    name: z.string().min(1),
    optionalRegistration: z.boolean().optional(),
    transport: z.enum(["remote", "stdio"]),
    url: z.string().url().optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (spec.catalog) {
      return;
    }
    if (spec.transport === "remote") {
      if (!spec.url) {
        ctx.addIssue({
          code: "custom",
          message: "remote MCP install spec must declare url or catalog",
          path: ["url"],
        });
      }
      if (spec.command) {
        ctx.addIssue({
          code: "custom",
          message: "remote MCP install spec cannot declare command",
          path: ["command"],
        });
      }
      if (spec.args) {
        ctx.addIssue({
          code: "custom",
          message: "remote MCP install spec cannot declare args",
          path: ["args"],
        });
      }
      if (spec.env) {
        ctx.addIssue({
          code: "custom",
          message: "remote MCP install spec cannot declare env",
          path: ["env"],
        });
      }
      return;
    }
    if (!spec.command) {
      ctx.addIssue({
        code: "custom",
        message: "stdio MCP install spec must declare command or catalog",
        path: ["command"],
      });
    }
    if (spec.headers) {
      ctx.addIssue({
        code: "custom",
        message: "stdio MCP install spec cannot declare headers",
        path: ["headers"],
      });
    }
    if (spec.url) {
      ctx.addIssue({
        code: "custom",
        message: "stdio MCP install spec cannot declare url",
        path: ["url"],
      });
    }
  });

const defaultInstallManifestSchema = z
  .object({
    mcps: z.array(pipelineMcpInstallSpecSchema),
    skills: z.array(z.unknown()).optional(),
    version: z.literal(1),
  })
  .strict();

export interface DefaultInstallManifest {
  mcps: PipelineMcpInstallSpec[];
  skills?: unknown[];
  version: 1;
}

function loadDefaultInstallManifest(): DefaultInstallManifest {
  const raw = JSON.parse(readFileSync(DEFAULT_INSTALL_MANIFEST_URL, "utf8"));
  const parsed = defaultInstallManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PipelineDefaultManifestError(
      [
        "Invalid defaults/install-manifest.json.",
        ...parsed.error.issues.map((issue) =>
          [issue.path.join("."), issue.message].filter(Boolean).join(": ")
        ),
      ].join("\n")
    );
  }
  return parsed.data;
}

export const DEFAULT_INSTALL_MANIFEST = loadDefaultInstallManifest();
export const DEFAULT_MCP_INSTALLS: PipelineMcpInstallSpec[] =
  DEFAULT_INSTALL_MANIFEST.mcps;

export function defaultMcpJson(): string {
  return `${JSON.stringify(
    {
      mcpServers: Object.fromEntries(
        [
          ["backlog", "oisin-pipeline-backlog"],
          ["context7", "oisin-pipeline-context7"],
          ["github-readonly", "oisin-pipeline-github-readonly"],
          ["playwright", "oisin-pipeline-playwright"],
          ["qdrant", "oisin-pipeline-qdrant"],
          ["semgrep", "oisin-pipeline-semgrep"],
          ["serena", "oisin-pipeline-serena"],
        ].map(([server, installName]) => [
          server,
          {
            args: [...DEFAULT_MCPM_ARGS, "run", installName],
            command: DEFAULT_MCPM_COMMAND,
          },
        ])
      ),
    },
    null,
    2
  )}\n`;
}

export async function installDefaultMcpsWithCli(
  specs: PipelineMcpInstallSpec[],
  cwd: string
): Promise<PipelineMcpInstallResult> {
  const skipped: PipelineMcpSkippedRegistration[] = [];
  for (const spec of specs) {
    const install = mcpInstallArgs(spec);
    if ("skipped" in install) {
      skipped.push(install.skipped);
      continue;
    }
    try {
      await execa(
        DEFAULT_MCPM_COMMAND,
        [...DEFAULT_MCPM_ARGS, ...install.args],
        {
          cwd,
          env: {
            MCPM_FORCE: "true",
            MCPM_JSON_OUTPUT: "true",
            MCPM_NON_INTERACTIVE: "true",
          },
          stdin: "ignore",
        }
      );
    } catch (err) {
      const error = err as {
        stderr?: string;
        stdout?: string;
        shortMessage?: string;
      };
      throw new PipelineMcpInstallError(
        [
          `Failed to register MCP server ${spec.name} with MCPM.`,
          "Pipeline init runs MCPM through `uvx --python 3.12 mcpm`.",
          "Install uv/uvx from https://docs.astral.sh/uv/ and re-run pipeline init.",
          redactMcpInstallOutput(error.shortMessage, install.redactions),
          redactMcpInstallOutput(error.stderr, install.redactions),
          redactMcpInstallOutput(error.stdout, install.redactions),
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
  }
  return { skipped };
}

interface McpInstallArgs {
  args: string[];
  redactions: string[];
}

interface McpSkippedInstall {
  skipped: PipelineMcpSkippedRegistration;
}

function mcpInstallArgs(
  spec: PipelineMcpInstallSpec
): McpInstallArgs | McpSkippedInstall {
  if (spec.catalog) {
    return {
      args: ["install", spec.catalog, "--force", "--alias", spec.name],
      redactions: [],
    };
  }
  const args = ["new", spec.name, "--type", spec.transport, "--force"];
  if (spec.transport === "remote") {
    if (!spec.url) {
      throw new PipelineMcpInstallError(
        `MCP server ${spec.name} is remote but has no url.`
      );
    }
    const redactions: string[] = [];
    try {
      const headers = Object.entries(spec.headers ?? {}).flatMap(
        ([key, value]) => {
          const headerValue = resolveMcpHeaderValue(spec.name, key, value);
          redactions.push(headerValue);
          return ["--headers", `${key}=${headerValue}`];
        }
      );
      return {
        args: [...args, "--url", spec.url, ...headers],
        redactions,
      };
    } catch (err) {
      if (
        spec.optionalRegistration &&
        err instanceof PipelineMcpMissingCredentialError
      ) {
        return {
          skipped: {
            missingEnv: err.missingEnv,
            name: spec.name,
            reason: `missing ${err.headerName} credentials`,
          },
        };
      }
      throw err;
    }
  }
  if (!spec.command) {
    throw new PipelineMcpInstallError(
      `MCP server ${spec.name} is stdio but has no command.`
    );
  }
  return {
    args: [
      ...args,
      "--command",
      spec.command,
      ...(spec.args?.length ? ["--args", spec.args.join(" ")] : []),
      ...Object.entries(spec.env ?? {}).flatMap(([key, value]) => [
        "--env",
        `${key}=${value}`,
      ]),
    ],
    redactions: [],
  };
}

const MCP_CREDENTIAL_PATTERN = /^\S+\s+(.+)$/;

function redactMcpInstallOutput(
  value: string | undefined,
  redactions: string[]
): string | undefined {
  if (!value) {
    return value;
  }
  const sensitiveValues = redactions
    .flatMap((item) => {
      const trimmed = item.trim();
      const credential = trimmed.match(MCP_CREDENTIAL_PATTERN)?.[1]?.trim();
      return credential ? [trimmed, credential] : [trimmed];
    })
    .filter((item) => item.length > 0);
  const escaped = [...new Set(sensitiveValues)]
    .sort((a, b) => b.length - a.length)
    .map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const sensitivePattern =
    escaped.length > 0 ? new RegExp(escaped.join("|"), "g") : null;
  const redacted = sensitivePattern
    ? value.replace(sensitivePattern, "[REDACTED]")
    : value;
  return redacted.replace(
    /Authorization=[^\r\n'"]+/gi,
    "Authorization=[REDACTED]"
  );
}

function resolveMcpHeaderValue(
  serverName: string,
  headerName: string,
  header: PipelineMcpHeaderValue
): string {
  if (typeof header === "string") {
    return header;
  }
  for (const source of header.sources ?? []) {
    const rawValue = process.env[source.env];
    if (rawValue && rawValue.trim().length > 0) {
      return `${source.prefix ?? ""}${rawValue}${source.suffix ?? ""}`;
    }
  }
  throw new PipelineMcpMissingCredentialError(
    serverName,
    headerName,
    header.sources.map((source) => source.env)
  );
}
