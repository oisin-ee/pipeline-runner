import { z } from "zod";
import {
  MCP_GATEWAY_BACKEND_LOCALITIES,
  MCP_GATEWAY_WORKSPACE_PATH_SOURCES,
} from "./catalog";

const REPO_LOCAL_WORKSPACE_PATH_SOURCE_MESSAGE = [
  "repo-local gateway backend must declare workspace_path_source",
  "as",
  "PIPELINE_TARGET_PATH or cwd",
].join(" ");

const mcpServerBaseSchema = z
  .object({
    args: z.array(z.string()).optional(),
    bearer_token_env_var: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    url: z
      .string()
      .url()
      .refine(
        (value) => ["http:", "https:"].includes(new URL(value).protocol),
        {
          message: "MCP server url must use http or https",
        }
      )
      .optional(),
  })
  .strict();

type McpServerInput = z.infer<typeof mcpServerBaseSchema>;
interface McpServerRefinement {
  message: string;
  path: (server: McpServerInput) => string[];
  violates: (server: McpServerInput) => boolean;
}

const hasCommand = (server: McpServerInput) => Boolean(server.command);
const hasUrl = (server: McpServerInput) => Boolean(server.url);
const hasAuthorizationHeader = (server: McpServerInput) =>
  Object.keys(server.headers ?? {}).some(
    (key) => key.toLowerCase() === "authorization"
  );

const mcpServerRefinements: McpServerRefinement[] = [
  {
    message: "MCP server must declare exactly one of command or url",
    path: (server) => (hasCommand(server) ? ["url"] : ["command"]),
    violates: (server) => hasCommand(server) === hasUrl(server),
  },
  {
    message: "args are only valid for command MCP servers",
    path: () => ["args"],
    violates: (server) => hasUrl(server) && Boolean(server.args),
  },
  {
    message: "env is only valid for command MCP servers",
    path: () => ["env"],
    violates: (server) => hasUrl(server) && Boolean(server.env),
  },
  {
    message: "headers are only valid for url MCP servers",
    path: () => ["headers"],
    violates: (server) => hasCommand(server) && Boolean(server.headers),
  },
  {
    message: "bearer_token_env_var is only valid for url MCP servers",
    path: () => ["bearer_token_env_var"],
    violates: (server) =>
      hasCommand(server) && Boolean(server.bearer_token_env_var),
  },
  {
    message:
      "headers.Authorization cannot be combined with bearer_token_env_var",
    path: () => ["bearer_token_env_var"],
    violates: (server) =>
      hasUrl(server) &&
      Boolean(server.bearer_token_env_var) &&
      hasAuthorizationHeader(server),
  },
];

export const mcpServerSchema = mcpServerBaseSchema.superRefine(
  (server, ctx) => {
    for (const refinement of mcpServerRefinements) {
      if (refinement.violates(server)) {
        ctx.addIssue({
          code: "custom",
          message: refinement.message,
          path: refinement.path(server),
        });
      }
    }
  }
);

const mcpGatewayBackendSchema = z
  .object({
    locality: z.enum(MCP_GATEWAY_BACKEND_LOCALITIES),
    required: z.boolean().default(true),
    tool_prefixes: z.array(z.string().min(1)).min(1),
    workspace_path_source: z
      .enum(MCP_GATEWAY_WORKSPACE_PATH_SOURCES)
      .optional(),
  })
  .strict()
  .superRefine((backend, ctx) => {
    if (backend.locality === "repo-local") {
      if (!backend.workspace_path_source) {
        ctx.addIssue({
          code: "custom",
          message: REPO_LOCAL_WORKSPACE_PATH_SOURCE_MESSAGE,
          path: ["workspace_path_source"],
        });
      }
      return;
    }
    if (backend.workspace_path_source) {
      ctx.addIssue({
        code: "custom",
        message:
          "workspace_path_source is only valid for repo-local gateway backends",
        path: ["workspace_path_source"],
      });
    }
  });

export const mcpGatewaySchema = z
  .object({
    backends: z.record(z.string(), mcpGatewayBackendSchema).default({}),
    default_profile: z.string().min(1).optional(),
    // PIPE-83.11: where the singleton pipeline gateway is registered. "project"
    // (default) embeds it in each repo's .opencode/opencode.json; "global" stops
    // the per-project synthesis and inherits one global registration (written
    // once via `moka gateway configure-host --scope global`).
    host_scope: z.enum(["project", "global"]).default("project"),
    mode: z.enum(["hosted", "local"]),
    provider: z.literal("toolhive"),
    authorization_env: z
      .string()
      .min(1)
      .default("PIPELINE_MCP_GATEWAY_AUTHORIZATION"),
    url: z
      .string()
      .url()
      .refine(
        (value) => ["http:", "https:"].includes(new URL(value).protocol),
        {
          message: "MCP gateway url must use http or https",
        }
      )
      .optional(),
    url_env: z.string().min(1).default("PIPELINE_MCP_GATEWAY_URL"),
  })
  .strict();
