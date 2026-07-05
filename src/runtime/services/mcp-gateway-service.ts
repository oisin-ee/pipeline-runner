import { Context, Effect, Layer, Option } from "effect";
import { execa } from "execa";

import { PipelineMcpGatewayError } from "../../mcp/gateway-error";
import type { ToolHiveWorkload } from "../../mcp/toolhive-vmcp";

interface ToolHiveListWorkload {
  readonly name?: unknown;
  readonly status?: unknown;
  readonly transport?: unknown;
  readonly transport_type?: unknown;
  readonly url?: unknown;
}

interface GatewayRpcResponse {
  readonly result?: { readonly tools?: unknown };
}

const NO_DOCKER_HOST = Option.none<string>();

const gatewayError = (message: string): PipelineMcpGatewayError =>
  new PipelineMcpGatewayError(message);

const execaErrorMessage = (error: unknown): string => {
  const subprocessError = error as { shortMessage?: string; stderr?: string };
  const subprocessMessage =
    subprocessError.shortMessage ?? subprocessError.stderr;
  if (subprocessMessage !== undefined && subprocessMessage.length > 0) {
    return subprocessMessage.trim();
  }
  return error instanceof Error ? error.message : String(error);
};

const execaGatewayError = (error: unknown): PipelineMcpGatewayError =>
  error instanceof PipelineMcpGatewayError
    ? error
    : gatewayError(execaErrorMessage(error));

const toolHiveWorkloadTransport = (
  item: ToolHiveListWorkload
): Option.Option<string> => {
  if (typeof item.transport_type === "string") {
    return Option.some(item.transport_type);
  }
  if (typeof item.transport === "string") {
    return Option.some(item.transport);
  }
  return Option.none();
};

const asString = (value: unknown): Option.Option<string> =>
  typeof value === "string" ? Option.some(value) : Option.none();

const toToolHiveWorkload = (item: ToolHiveListWorkload): ToolHiveWorkload[] => {
  if (typeof item.name !== "string") {
    return [];
  }
  return [
    {
      name: item.name,
      status: Option.getOrUndefined(asString(item.status)),
      transport: Option.getOrUndefined(toolHiveWorkloadTransport(item)),
      url: Option.getOrUndefined(asString(item.url)),
    },
  ];
};

const parseToolHiveWorkloads = (stdout: string): ToolHiveWorkload[] => {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw gatewayError(
      "ToolHive list returned malformed JSON while reconciling MCP gateway workloads."
    );
  }
  if (!Array.isArray(parsed)) {
    throw gatewayError(
      "ToolHive list returned a non-array payload while reconciling MCP gateway workloads."
    );
  }
  return parsed.flatMap((item: ToolHiveListWorkload) =>
    toToolHiveWorkload(item)
  );
};

const isHealthyGatewayStatus = (status: number): boolean =>
  (status >= 200 && status < 300) || status === 405;

const activeDockerHost = (cwd: string): Effect.Effect<Option.Option<string>> =>
  Effect.tryPromise({
    catch: () => {
      /* empty */
    },
    try: async () => {
      const result = await execa("docker", ["context", "inspect"], {
        cwd,
        stdin: "ignore",
      });
      const contexts = JSON.parse(result.stdout) as {
        Endpoints?: { docker?: { Host?: unknown } };
      }[];
      const host = contexts[0]?.Endpoints?.docker?.Host;
      return typeof host === "string" && host.length > 0
        ? Option.some(host)
        : Option.none();
    },
  }).pipe(Effect.catch(() => Effect.succeed(NO_DOCKER_HOST)));

const toolhiveEnv = (cwd: string): Effect.Effect<NodeJS.ProcessEnv> => {
  if (
    process.env.DOCKER_HOST !== undefined &&
    process.env.DOCKER_HOST.length > 0
  ) {
    return Effect.succeed(process.env);
  }
  return activeDockerHost(cwd).pipe(
    Effect.map((dockerHost) =>
      Option.match(dockerHost, {
        onNone: () => process.env,
        onSome: (value) => ({ ...process.env, DOCKER_HOST: value }),
      })
    )
  );
};

const fetchGateway = (
  url: string,
  init: RequestInit
): Effect.Effect<Response, PipelineMcpGatewayError> =>
  Effect.tryPromise({
    catch: execaGatewayError,
    try: async () => await fetch(url, init),
  });

export class McpGatewayService extends Context.Service<
  McpGatewayService,
  {
    readonly callGatewayRpc: (
      url: string,
      body: Record<string, unknown>,
      authorization?: string
    ) => Effect.Effect<GatewayRpcResponse, PipelineMcpGatewayError>;
    readonly firstHealthyGatewayResponse: (
      urls: string[],
      authorization?: string
    ) => Effect.Effect<Option.Option<Response>, PipelineMcpGatewayError>;
    readonly listToolHiveGroupWorkloads: (
      group: string,
      cwd: string
    ) => Effect.Effect<ToolHiveWorkload[], PipelineMcpGatewayError>;
    readonly localGatewayStatus: (
      cwd: string
    ) => Effect.Effect<string, PipelineMcpGatewayError>;
    readonly runToolHiveVersion: (
      cwd: string
    ) => Effect.Effect<void, PipelineMcpGatewayError>;
    readonly serveToolHiveVmcp: (
      configPath: string,
      cwd: string
    ) => Effect.Effect<void, PipelineMcpGatewayError>;
    readonly validateToolHiveVmcp: (
      configPath: string,
      cwd: string
    ) => Effect.Effect<void, PipelineMcpGatewayError>;
  }
>()("McpGatewayService") {}

export const McpGatewayServiceLive = Layer.succeed(McpGatewayService, {
  callGatewayRpc: (url, body, authorization) =>
    fetchGateway(url, {
      body: JSON.stringify(body),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(authorization === undefined || authorization.length === 0
          ? {}
          : { Authorization: authorization }),
      },
      method: "POST",
    }).pipe(
      Effect.flatMap((response) => {
        if (!response.ok) {
          return Effect.fail(
            gatewayError(`Gateway MCP request failed: HTTP ${response.status}.`)
          );
        }
        return Effect.tryPromise({
          catch: execaGatewayError,
          try: async () =>
            await (response.json() as Promise<GatewayRpcResponse>),
        });
      })
    ),
  firstHealthyGatewayResponse: (urls, authorization) =>
    Effect.gen(function* firstHealthyGatewayResponse() {
      for (const url of urls) {
        const response = yield* fetchGateway(url, {
          headers: {
            Accept: "application/json, text/event-stream",
            ...(authorization === undefined || authorization.length === 0
              ? {}
              : { Authorization: authorization }),
          },
          method: "GET",
        });
        if (isHealthyGatewayStatus(response.status)) {
          return Option.some(response);
        }
      }
      return Option.none();
    }),
  listToolHiveGroupWorkloads: (group, cwd) =>
    Effect.gen(function* listToolHiveGroupWorkloads() {
      const env = yield* toolhiveEnv(cwd);
      const result = yield* Effect.tryPromise({
        catch: execaGatewayError,
        try: async () =>
          await execa("thv", ["list", "--group", group, "--format", "json"], {
            cwd,
            env,
            stdin: "ignore",
          }),
      });
      return yield* Effect.try({
        catch: execaGatewayError,
        try: () => parseToolHiveWorkloads(result.stdout),
      });
    }),
  localGatewayStatus: (cwd) =>
    Effect.gen(function* localGatewayStatus() {
      const env = yield* toolhiveEnv(cwd);
      const result = yield* Effect.tryPromise({
        catch: execaGatewayError,
        try: async () => await execa("thv", ["list"], { cwd, env }),
      });
      return result.stdout.trim();
    }),
  runToolHiveVersion: (cwd) =>
    Effect.gen(function* runToolHiveVersion() {
      const env = yield* toolhiveEnv(cwd);
      yield* Effect.tryPromise({
        catch: execaGatewayError,
        try: async () =>
          await execa("thv", ["version"], { cwd, env, stdin: "ignore" }),
      });
    }),
  serveToolHiveVmcp: (configPath, cwd) =>
    Effect.gen(function* serveToolHiveVmcp() {
      const env = yield* toolhiveEnv(cwd);
      yield* Effect.tryPromise({
        catch: execaGatewayError,
        try: async () =>
          await execa(
            "thv",
            [
              "vmcp",
              "serve",
              "--config",
              configPath,
              "--host",
              "127.0.0.1",
              "--port",
              "4483",
            ],
            { cwd, env, stderr: "inherit", stdout: "inherit" }
          ),
      });
    }),
  validateToolHiveVmcp: (configPath, cwd) =>
    Effect.gen(function* validateToolHiveVmcp() {
      const env = yield* toolhiveEnv(cwd);
      yield* Effect.tryPromise({
        catch: execaGatewayError,
        try: async () =>
          await execa("thv", ["vmcp", "validate", "--config", configPath], {
            cwd,
            env,
            stdin: "ignore",
          }),
      });
    }),
});
