import { Effect } from "effect";
import { z } from "zod";
import { sequenceTicketBatchesEffect, type TicketGraph } from "./ticket-graph";

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
export const loopStateSchema = z.enum([
  "queued",
  "running",
  "merging",
  "passed",
  "blocked",
]);

export type LoopState = z.infer<typeof loopStateSchema>;

/* ---------- DTO node ---------- */

const ticketGraphDtoNodeSchema = z.object({
  id: z.string().min(1),
  loopState: loopStateSchema,
  priority: z.enum(["high", "medium", "low"]).optional(),
  status: z.enum(["To Do", "In Progress", "Done"]),
  title: z.string().min(1),
});

type TicketGraphDtoNode = z.infer<typeof ticketGraphDtoNodeSchema>;

/* ---------- DTO edge ---------- */

const ticketGraphDtoEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

type TicketGraphDtoEdge = z.infer<typeof ticketGraphDtoEdgeSchema>;

/* ---------- full DTO ---------- */

export const ticketGraphDtoSchema = z.object({
  batches: z.array(z.array(z.string().min(1))),
  dangling: z.array(z.string()),
  edges: z.array(ticketGraphDtoEdgeSchema),
  nodes: z.array(ticketGraphDtoNodeSchema),
});

export type TicketGraphDto = z.infer<typeof ticketGraphDtoSchema>;

/* ---------- serializer ---------- */

const EMPTY_BATCHES: string[][] = [];

/**
 * Convert a `TicketGraph` to the cross-repo wire DTO.
 *
 * All nodes default to `loopState: "queued"` — the controller updates
 * individual nodes via `loop.node.transition` events as work proceeds.
 *
 * Returns an Effect because `sequenceTicketBatchesEffect` is effectful (it can
 * fail on a graph that cannot be topologically sorted, which should never
 * happen for a well-formed backlog but must be handled explicitly).
 */
export function serializeTicketGraph(
  graph: TicketGraph
): Effect.Effect<TicketGraphDto, never> {
  return Effect.gen(function* () {
    const batches = yield* sequenceTicketBatchesEffect(graph).pipe(
      Effect.catchAll(() => Effect.succeed(EMPTY_BATCHES))
    );

    const nodes: TicketGraphDtoNode[] = [...graph.tasksById.values()].map(
      (task): TicketGraphDtoNode => ({
        id: task.id,
        loopState: "queued",
        ...(task.priority !== undefined ? { priority: task.priority } : {}),
        status: task.status,
        title: task.title,
      })
    );

    const edges: TicketGraphDtoEdge[] = graph.dependencyGraph
      .edges()
      .map((e) => ({ from: e.v, to: e.w }));

    const dangling: string[] = [...graph.danglingDependencies];

    return { batches, dangling, edges, nodes };
  });
}
