import * as R from "effect/Record";
import * as Schema from "effect/Schema";

import {
  mutableArray,
  requiredString,
  stringRecord,
  urlString,
  withDefault,
  struct,
} from "../../schema-boundary";
import {
  MCP_GATEWAY_BACKEND_LOCALITIES,
  MCP_GATEWAY_WORKSPACE_PATH_SOURCES,
} from "./catalog";

const REPO_LOCAL_WORKSPACE_PATH_SOURCE_MESSAGE = [
  "repo-local gateway backend must declare workspace_path_source",
  "as",
  "PIPELINE_TARGET_PATH or cwd",
].join(" ");

const httpUrlString = urlString.check(
  Schema.makeFilter<string>(
    (value) =>
      ["http:", "https:"].includes(new URL(value).protocol) ||
      "URL must use http or https",
    {
      description: "MCP URL must use HTTP or HTTPS.",
      identifier: "McpHttpUrlString",
      title: "MCP HTTP URL string",
    }
  )
);

const mcpServerBaseSchema = struct({
  args: Schema.optional(mutableArray(Schema.String)),
  bearer_token_env_var: Schema.optional(requiredString),
  command: Schema.optional(requiredString),
  env: Schema.optional(stringRecord),
  headers: Schema.optional(stringRecord),
  url: Schema.optional(httpUrlString),
});

type McpServerInput = typeof mcpServerBaseSchema.Type;
interface McpServerRefinement {
  message: string;
  violates: (server: McpServerInput) => boolean;
}

const hasCommand = (server: McpServerInput) => Boolean(server.command);
const hasUrl = (server: McpServerInput) => Boolean(server.url);
const hasAuthorizationHeader = (server: McpServerInput) =>
  R.keys(server.headers ?? {}).some(
    (key) => key.toLowerCase() === "authorization"
  );

const mcpServerRefinements: readonly McpServerRefinement[] = [
  {
    message: "MCP server must declare exactly one of command or url",
    violates: (server) => hasCommand(server) === hasUrl(server),
  },
  {
    message: "args are only valid for command MCP servers",
    violates: (server) => hasUrl(server) && Boolean(server.args),
  },
  {
    message: "env is only valid for command MCP servers",
    violates: (server) => hasUrl(server) && Boolean(server.env),
  },
  {
    message: "headers are only valid for url MCP servers",
    violates: (server) => hasCommand(server) && Boolean(server.headers),
  },
  {
    message: "bearer_token_env_var is only valid for url MCP servers",
    violates: (server) =>
      hasCommand(server) && Boolean(server.bearer_token_env_var),
  },
  {
    message:
      "headers.Authorization cannot be combined with bearer_token_env_var",
    violates: (server) =>
      hasUrl(server) &&
      Boolean(server.bearer_token_env_var) &&
      hasAuthorizationHeader(server),
  },
];

export const mcpServerSchema = mcpServerBaseSchema.check(
  Schema.makeFilter(
    (server) => {
      const failed = mcpServerRefinements.find((refinement) =>
        refinement.violates(server)
      );
      return failed?.message ?? true;
    },
    {
      description: "MCP server must define one transport with valid fields.",
      identifier: "McpServerTransport",
      title: "MCP server transport",
    }
  )
);

const mcpGatewayBackendSchema = struct({
  locality: Schema.Literals(MCP_GATEWAY_BACKEND_LOCALITIES),
  required: withDefault(Schema.Boolean, true),
  tool_prefixes: mutableArray(requiredString).check(Schema.isNonEmpty()),
  workspace_path_source: Schema.optional(
    Schema.Literals(MCP_GATEWAY_WORKSPACE_PATH_SOURCES)
  ),
}).check(
  Schema.makeFilter(
    (backend) => {
      if (backend.locality === "repo-local") {
        return (
          backend.workspace_path_source !== undefined ||
          REPO_LOCAL_WORKSPACE_PATH_SOURCE_MESSAGE
        );
      }
      return (
        backend.workspace_path_source === undefined ||
        "workspace_path_source is only valid for repo-local gateway backends"
      );
    },
    {
      description:
        "Repo-local MCP gateway backend must declare workspace source.",
      identifier: "McpGatewayBackendWorkspaceSource",
      title: "MCP gateway backend workspace source",
    }
  )
);

export const mcpGatewaySchema = struct({
  authorization_env: withDefault(
    requiredString,
    "PIPELINE_MCP_GATEWAY_AUTHORIZATION"
  ),
  backends: withDefault(
    Schema.Record(Schema.String, mcpGatewayBackendSchema),
    {}
  ),
  default_profile: Schema.optional(requiredString),
  host_scope: withDefault(Schema.Literals(["project", "global"]), "project"),
  mode: Schema.Literals(["hosted", "local"]),
  provider: Schema.Literal("toolhive"),
  url: Schema.optional(httpUrlString),
  url_env: withDefault(requiredString, "PIPELINE_MCP_GATEWAY_URL"),
});
