import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  mutableArray,
  nonEmptyMutableArray,
  parseResultWithSchema,
  trimmedRequiredString,
  withDefault,
  struct,
} from "../schema-boundary";
import { formatSchemaIssues, errorMessage } from "./validation-error-format";

const LOCAL_KEY_RE = /^[a-z][a-z0-9-]*$/u;

const nonEmptyStringSchema = trimmedRequiredString;
const localKeySchema = nonEmptyStringSchema.check(
  Schema.makeFilter(
    (value) =>
      LOCAL_KEY_RE.test(value) ||
      "local keys must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens",
    {
      description: "Lowercase local ticket key with letters, numbers, and hyphens.",
      identifier: "TicketPlanLocalKey",
      title: "Ticket plan local key",
    },
  ),
);

const acceptanceCriterionSchema = struct({
  evidence: nonEmptyStringSchema,
  text: nonEmptyStringSchema,
});

const plannedTaskSchema = struct({
  acceptance_criteria: nonEmptyMutableArray(acceptanceCriterionSchema),
  depends_on: withDefault(mutableArray(localKeySchema), []),
  description: nonEmptyStringSchema,
  key: localKeySchema,
  likely_files: withDefault(mutableArray(nonEmptyStringSchema), []),
  plan: nonEmptyStringSchema,
  priority: Schema.optional(Schema.Literals(["high", "medium", "low"])),
  references: withDefault(mutableArray(nonEmptyStringSchema), []),
  title: nonEmptyStringSchema,
});

const epicTaskSchema = struct({
  acceptance_criteria: nonEmptyMutableArray(acceptanceCriterionSchema),
  description: nonEmptyStringSchema,
  key: withDefault(localKeySchema, "epic"),
  likely_files: withDefault(mutableArray(nonEmptyStringSchema), []),
  plan: nonEmptyStringSchema,
  priority: Schema.optional(Schema.Literals(["high", "medium", "low"])),
  references: withDefault(mutableArray(nonEmptyStringSchema), []),
  title: nonEmptyStringSchema,
});

export type TicketPlan = typeof ticketPlanSchema.Type;
export type TicketPlanTask = TicketPlan["tickets"][number];
export type TicketPlanEpic = NonNullable<TicketPlan["epic"]>;

interface TicketPlanIssue {
  issue: string;
  path: readonly PropertyKey[];
}

interface TicketKeyValidation {
  issues: readonly TicketPlanIssue[];
  seenKeys: HashMap.HashMap<string, number>;
}

const emptyTicketKeyValidation: TicketKeyValidation = {
  issues: [],
  seenKeys: HashMap.empty<string, number>(),
};

class TicketPlanError extends Schema.TaggedErrorClass<TicketPlanError>()("TicketPlanError", {
  message: Schema.String,
}) {}

const validateUniqueTicketKeys = (tickets: readonly TicketPlanTask[]): TicketKeyValidation =>
  Arr.reduce(tickets, emptyTicketKeyValidation, (state, ticket, index) => {
    const duplicateIssue = Option.map(
      HashMap.get(state.seenKeys, ticket.key),
      (firstIndex): TicketPlanIssue => ({
        issue: `duplicate local ticket key '${ticket.key}' first used at tickets.${firstIndex}.key`,
        path: ["tickets", index, "key"],
      }),
    );
    return {
      issues: [...state.issues, ...Arr.fromOption(duplicateIssue)],
      seenKeys: HashMap.set(state.seenKeys, ticket.key, index),
    };
  });

const validateEpicKey = (
  epic: Option.Option<TicketPlanEpic>,
  seenKeys: HashMap.HashMap<string, number>,
): readonly TicketPlanIssue[] =>
  Option.match(epic, {
    onNone: () => [],
    onSome: (value) =>
      HashMap.has(seenKeys, value.key)
        ? [
            {
              issue: `epic key '${value.key}' conflicts with a ticket key`,
              path: ["epic", "key"],
            },
          ]
        : [],
  });

const validateTicketDependencies = (
  ticket: TicketPlanTask,
  ticketIndex: number,
  seenKeys: HashMap.HashMap<string, number>,
): readonly TicketPlanIssue[] =>
  Arr.flatMap(ticket.depends_on, (dependencyKey, dependencyIndex) =>
    HashMap.has(seenKeys, dependencyKey)
      ? []
      : [
          {
            issue: `unknown dependency key '${dependencyKey}'`,
            path: ["tickets", ticketIndex, "depends_on", dependencyIndex],
          },
        ],
  );

const validateLocalDependencies = (
  tickets: readonly TicketPlanTask[],
  seenKeys: HashMap.HashMap<string, number>,
): readonly TicketPlanIssue[] =>
  Arr.flatMap(tickets, (ticket, ticketIndex) => validateTicketDependencies(ticket, ticketIndex, seenKeys));

const ticketPlanBaseSchema = struct({
  epic: Schema.optional(epicTaskSchema),
  tickets: nonEmptyMutableArray(plannedTaskSchema),
});

export const ticketPlanSchema = ticketPlanBaseSchema.check(
  Schema.makeFilter(
    (plan) => {
      const { issues: keyIssues, seenKeys } = validateUniqueTicketKeys(plan.tickets);
      const issues = [
        ...keyIssues,
        ...validateEpicKey(Option.fromUndefinedOr(plan.epic), seenKeys),
        ...validateLocalDependencies(plan.tickets, seenKeys),
      ];
      return Arr.match(issues, {
        onEmpty: () => true,
        onNonEmpty: (values) => values,
      });
    },
    {
      description: "Ticket plan keys must be unique and dependencies must resolve.",
      identifier: "TicketPlanGraphIntegrity",
      title: "Ticket plan graph integrity",
    },
  ),
);

export const parseTicketPlanEffect = (source: string): Effect.Effect<TicketPlan, TicketPlanError> =>
  Effect.gen(function* effectBody() {
    const json = parseResultWithSchema(Schema.UnknownFromJsonString, source);
    if (!json.ok) {
      return yield* Effect.fail(
        new TicketPlanError({
          message: `Could not parse ticket plan JSON: ${errorMessage(json.error)}`,
        }),
      );
    }
    const decoded = parseResultWithSchema(ticketPlanSchema, json.value, {
      onExcessProperty: "error",
    });
    if (decoded.ok) {
      return decoded.value;
    }
    return yield* Effect.fail(
      new TicketPlanError({
        message: `Invalid ticket plan: ${formatSchemaIssues(decoded.issues)}`,
      }),
    );
  });
