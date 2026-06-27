import type { z } from "zod";

interface ConfigReferenceInput {
  default_workflow: string;
  entrypoints: Record<string, { schedule?: string; workflow?: string }>;
  profiles: Record<string, unknown>;
  scheduler: {
    commands: Record<string, { catalog?: string; schedule?: string }>;
    node_catalogs: Record<
      string,
      { nodes: Record<string, { profile?: string }> }
    >;
  };
  schedules: Record<
    string,
    { node_catalog?: string; planner_profile?: string }
  >;
  workflows: Record<string, unknown>;
}

interface ConfigReferenceIssue {
  message: string;
  path: (number | string)[];
}

interface RegistryReferenceRule<TRecord> {
  field: string;
  message: (recordId: string, value: string) => string;
  read: (record: TRecord) => string | undefined;
  registry: Record<string, unknown>;
}

export function validateConfigReferences(
  config: ConfigReferenceInput,
  ctx: z.RefinementCtx
): void {
  addConfigSchemaIssues(ctx, configReferenceIssues(config));
}

function configReferenceIssues(
  config: ConfigReferenceInput
): ConfigReferenceIssue[] {
  return [
    ...missingRegistryReferenceIssue({
      message: (_field, value) => `default workflow '${value}' is not declared`,
      path: ["default_workflow"],
      registry: config.workflows,
      value: config.default_workflow,
    }),
    ...registryReferenceIssues("entrypoints", config.entrypoints, [
      {
        field: "workflow",
        message: (entrypointId, value) =>
          `entrypoint '${entrypointId}' references missing workflow '${value}'`,
        read: (entrypoint) => entrypoint.workflow,
        registry: config.workflows,
      },
      {
        field: "schedule",
        message: (entrypointId, value) =>
          `entrypoint '${entrypointId}' references missing schedule '${value}'`,
        read: (entrypoint) => entrypoint.schedule,
        registry: config.schedules,
      },
    ]),
    ...registryReferenceIssues("schedules", config.schedules, [
      {
        field: "planner_profile",
        message: (scheduleId, value) =>
          `schedule '${scheduleId}' references missing planner profile '${value}'`,
        read: (schedule) => schedule.planner_profile,
        registry: config.profiles,
      },
      {
        field: "node_catalog",
        message: (scheduleId, value) =>
          `schedule '${scheduleId}' references missing scheduler node catalog '${value}'`,
        read: (schedule) => schedule.node_catalog,
        registry: config.scheduler.node_catalogs,
      },
    ]),
    ...registryReferenceIssues(
      "scheduler.commands",
      config.scheduler.commands,
      [
        {
          field: "catalog",
          message: (commandId, value) =>
            `scheduler command '${commandId}' references missing node catalog '${value}'`,
          read: (command) => command.catalog,
          registry: config.scheduler.node_catalogs,
        },
        {
          field: "schedule",
          message: (commandId, value) =>
            `scheduler command '${commandId}' references missing schedule '${value}'`,
          read: (command) => command.schedule,
          registry: config.schedules,
        },
      ]
    ),
    ...Object.entries(config.scheduler.node_catalogs).flatMap(
      ([catalogId, catalog]) =>
        registryReferenceIssues(
          `scheduler.node_catalogs.${catalogId}.nodes`,
          catalog.nodes,
          [
            {
              field: "profile",
              message: (nodeId, value) =>
                `scheduler node '${catalogId}.${nodeId}' references missing profile '${value}'`,
              read: (node) => node.profile,
              registry: config.profiles,
            },
          ]
        )
    ),
  ];
}

function registryReferenceIssues<TRecord>(
  registryPath: string,
  records: Record<string, TRecord>,
  rules: RegistryReferenceRule<TRecord>[]
): ConfigReferenceIssue[] {
  return Object.entries(records).flatMap(([recordId, record]) =>
    rules.flatMap((rule) =>
      missingRegistryReferenceIssue({
        message: (_field, value) => rule.message(recordId, value),
        path: [registryPath, recordId, rule.field],
        registry: rule.registry,
        value: rule.read(record),
      })
    )
  );
}

function missingRegistryReferenceIssue({
  message,
  path,
  registry,
  value,
}: {
  message: (field: string, value: string) => string;
  path: (number | string)[];
  registry: Record<string, unknown>;
  value: string | undefined;
}): ConfigReferenceIssue[] {
  return value && !Object.hasOwn(registry, value)
    ? [{ message: message(String(path.at(-1)), value), path }]
    : [];
}

function addConfigSchemaIssues(
  ctx: z.RefinementCtx,
  issues: ConfigReferenceIssue[]
): void {
  for (const issue of issues) {
    addConfigSchemaIssue(ctx, issue.path, issue.message);
  }
}

function addConfigSchemaIssue(
  ctx: z.RefinementCtx,
  path: (number | string)[],
  message: string
): void {
  ctx.addIssue({ code: "custom", path, message });
}
