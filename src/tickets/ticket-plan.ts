import { Data, Effect, Option } from "effect";
import { z } from "zod";

import { errorMessage, formatZodIssues } from "./validation-error-format";

const LOCAL_KEY_RE = /^[a-z][a-z0-9-]*$/u;

const nonEmptyStringSchema = z.string().trim().min(1);
const localKeySchema = nonEmptyStringSchema.regex(LOCAL_KEY_RE, {
  message:
    "local keys must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens",
});

const acceptanceCriterionSchema = z
  .object({
    evidence: nonEmptyStringSchema,
    text: nonEmptyStringSchema,
  })
  .strict();

const plannedTaskSchema = z
  .object({
    acceptance_criteria: z.array(acceptanceCriterionSchema).min(1),
    depends_on: z.array(localKeySchema).default([]),
    description: nonEmptyStringSchema,
    key: localKeySchema,
    likely_files: z.array(nonEmptyStringSchema).default([]),
    plan: nonEmptyStringSchema,
    priority: z.enum(["high", "medium", "low"]).optional(),
    references: z.array(nonEmptyStringSchema).default([]),
    title: nonEmptyStringSchema,
  })
  .strict();

const epicTaskSchema = plannedTaskSchema
  .omit({ depends_on: true })
  .extend({ key: localKeySchema.default("epic") })
  .strict();

export type TicketPlan = z.output<typeof ticketPlanSchema>;
export type TicketPlanTask = TicketPlan["tickets"][number];
export type TicketPlanEpic = NonNullable<TicketPlan["epic"]>;

class TicketPlanError extends Data.TaggedError("TicketPlanError")<{
  readonly message: string;
}> {}

const validateUniqueTicketKeys = (
  tickets: readonly TicketPlanTask[],
  ctx: z.RefinementCtx
): ReadonlyMap<string, number> => {
  const seenKeys = new Map<string, number>();
  for (const [index, ticket] of tickets.entries()) {
    const firstIndex = seenKeys.get(ticket.key);
    if (firstIndex !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `duplicate local ticket key '${ticket.key}' first used at tickets.${firstIndex}.key`,
        path: ["tickets", index, "key"],
      });
    }
    seenKeys.set(ticket.key, index);
  }
  return seenKeys;
};

const validateEpicKey = (
  epic: Option.Option<TicketPlanEpic>,
  seenKeys: ReadonlyMap<string, number>,
  ctx: z.RefinementCtx
): void => {
  if (Option.isNone(epic) || !seenKeys.has(epic.value.key)) {
    return;
  }
  ctx.addIssue({
    code: "custom",
    message: `epic key '${epic.value.key}' conflicts with a ticket key`,
    path: ["epic", "key"],
  });
};

const validateTicketDependencies = (
  ticket: TicketPlanTask,
  ticketIndex: number,
  seenKeys: ReadonlyMap<string, number>,
  ctx: z.RefinementCtx
): void => {
  for (const [dependencyIndex, dependencyKey] of ticket.depends_on.entries()) {
    if (seenKeys.has(dependencyKey)) {
      continue;
    }
    ctx.addIssue({
      code: "custom",
      message: `unknown dependency key '${dependencyKey}'`,
      path: ["tickets", ticketIndex, "depends_on", dependencyIndex],
    });
  }
};

const validateLocalDependencies = (
  tickets: readonly TicketPlanTask[],
  seenKeys: ReadonlyMap<string, number>,
  ctx: z.RefinementCtx
): void => {
  for (const [ticketIndex, ticket] of tickets.entries()) {
    validateTicketDependencies(ticket, ticketIndex, seenKeys, ctx);
  }
};

export const ticketPlanSchema = z
  .object({
    epic: epicTaskSchema.optional(),
    tickets: z.array(plannedTaskSchema).min(1),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const seenKeys = validateUniqueTicketKeys(plan.tickets, ctx);
    validateEpicKey(Option.fromUndefinedOr(plan.epic), seenKeys, ctx);
    validateLocalDependencies(plan.tickets, seenKeys, ctx);
  });

export const parseTicketPlanEffect = (
  source: string
): Effect.Effect<TicketPlan, TicketPlanError> =>
  Effect.gen(function* effectBody() {
    const json = yield* Effect.try({
      catch: (error) =>
        new TicketPlanError({
          message: `Could not parse ticket plan JSON: ${errorMessage(error)}`,
        }),
      try: () => JSON.parse(source) as unknown,
    });
    const decoded = ticketPlanSchema.safeParse(json);
    if (decoded.success) {
      return decoded.data;
    }
    return yield* Effect.fail(
      new TicketPlanError({
        message: `Invalid ticket plan: ${formatZodIssues(decoded.error.issues)}`,
      })
    );
  });
