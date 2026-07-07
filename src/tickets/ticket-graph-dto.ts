import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { graphEdgeIds } from "../planning/graph";
import { mutableArray, requiredString, struct } from "../schema-boundary";
import { sequenceTicketBatchesEffect } from "./ticket-graph";
import type { TicketGraph, TicketGraphError } from "./ticket-graph";

/*
 * Wire DTO for TicketGraph — consumed cross-repo by pipeline-console.
 *
 * loopState is the SINGLE exported source of truth for node lifecycle in the
 * cloud loop controller. All consumers import from here; no parallel literals
 * elsewhere.
 */

/**
 * Node lifecycle in the loop controller DAG traversal.
 * One concept owns this variation — this enum is it.
 */
const literalValues = <const T extends readonly string[]>(values: T): T =>
  values;

export const LOOP_STATES = literalValues([
  "queued",
  "running",
  "merging",
  "passed",
  "blocked",
]);

const loopState = Schema.Literals(LOOP_STATES);

export { loopState as loopStateSchema };

export type LoopState = typeof loopState.Type;

/* ---------- DTO node ---------- */

const ticketGraphDtoNode = struct({
  id: requiredString,
  loopState,
  priority: Schema.optional(Schema.Literals(["high", "medium", "low"])),
  status: Schema.Literals(["To Do", "In Progress", "Done"]),
  title: requiredString,
});

type TicketGraphDtoNode = typeof ticketGraphDtoNode.Type;

/* ---------- DTO edge ---------- */

const ticketGraphDtoEdge = struct({
  from: requiredString,
  to: requiredString,
});

type TicketGraphDtoEdge = typeof ticketGraphDtoEdge.Type;

/* ---------- full DTO ---------- */

const ticketGraphDto = struct({
  batches: mutableArray(mutableArray(requiredString)),
  dangling: mutableArray(Schema.String),
  edges: mutableArray(ticketGraphDtoEdge),
  nodes: mutableArray(ticketGraphDtoNode),
});

export { ticketGraphDto as ticketGraphDtoSchema };

export type TicketGraphDto = typeof ticketGraphDto.Type;

/* ---------- serializer ---------- */

/**
 * Convert a `TicketGraph` to the cross-repo wire DTO.
 *
 * All nodes default to `loopState: "queued"` — the controller updates
 * individual nodes via `loop.node.transition` events while work proceeds.
 *
 * Returns an Effect because `sequenceTicketBatchesEffect` is effectful (it can
 * fail on a graph that cannot be topologically sorted, which should never
 * happen for a well-formed backlog but must be handled explicitly).
 */
export const serializeTicketGraph = (
  graph: TicketGraph
): Effect.Effect<TicketGraphDto, TicketGraphError> =>
  Effect.gen(function* effectBody() {
    const batches = yield* sequenceTicketBatchesEffect(graph);

    const nodes: TicketGraphDtoNode[] = [...graph.tasksById.values()].map(
      (task): TicketGraphDtoNode => ({
        id: task.id,
        loopState: "queued",
        ...(task.priority === undefined ? {} : { priority: task.priority }),
        status: task.status,
        title: task.title,
      })
    );

    const edges: TicketGraphDtoEdge[] = graphEdgeIds(graph.dependencyGraph);

    const dangling: string[] = [...graph.danglingDependencies];

    return { batches, dangling, edges, nodes };
  });
