import { Effect, Option } from "effect";

import type { MokaSubmitInput, MokaSubmitResult } from "../moka-submit";
import { submitMoka } from "../moka-submit";
import type { BacklogTaskRecord } from "../tickets/backlog-task-store";
import { buildTicketGraphEffect } from "../tickets/ticket-graph";
import { selectReadyTickets } from "../tickets/ticket-selection";
import type { TicketSelectionStrategy } from "../tickets/ticket-selection";
import { loadBacklogRecords } from "./backlog-records";

// ===========================================================================
// PIPE-88.8 — `moka loop` CLI + cloud submission
//
// `moka loop` submits the headless controller as a long-running CLOUD command
// workflow: the in-cluster pod runs `moka loop-controller <flags>`, which drives
// the loop and emits loop.* events to the console sink. The CLI first validates
// the backlog locally — a cyclic or empty backlog refuses to start (non-zero
// exit) rather than submitting a controller that would immediately fail.
// ===========================================================================

const LOOP_STRATEGIES: readonly TicketSelectionStrategy[] = [
  "priority",
  "bfs",
  "dfs",
];

const DEFAULT_STRATEGY: TicketSelectionStrategy = "priority";

/** Parsed `moka loop` flags after normalization. */
export interface LoopFlags {
  readonly maxMergePolls?: number;
  readonly maxRemediationAttempts?: number;
  readonly rootId?: string;
  readonly strategy: TicketSelectionStrategy;
}

/** Raw commander option bag for the `loop` command. */
export interface LoopCommandOptions {
  readonly maxRemediationAttempts?: string;
  readonly mergeTimeout?: string;
  readonly root?: string;
  readonly strategy?: string;
}

/** Seams so the command is testable without touching the backlog FS or k8s. */
export interface LoopCommandSeams {
  readonly loadTasks?: (
    worktreePath: string
  ) => Effect.Effect<readonly BacklogTaskRecord[], Error>;
  readonly submitMoka?: (input: MokaSubmitInput) => Promise<MokaSubmitResult>;
}

export interface LoopSubmitInput {
  readonly brokerAuth: MokaSubmitInput["brokerAuth"];
  readonly config: MokaSubmitInput["config"];
  readonly eventUrl?: string;
  readonly flags: LoopFlags;
  readonly gitCredentialsSecretName?: string;
  readonly githubAuthSecretName?: string;
  readonly image?: string;
  readonly kubeconfigPath?: string;
  readonly namespace?: string;
  readonly serviceAccountName?: string;
  readonly worktreePath: string;
}

const parseStrategy = (value: Option.Option<string>): TicketSelectionStrategy =>
  Option.match(value, {
    onNone: () => DEFAULT_STRATEGY,
    onSome: (selected) => {
      const match = LOOP_STRATEGIES.find((strategy) => strategy === selected);
      if (match === undefined) {
        throw new Error(
          `--strategy must be one of ${LOOP_STRATEGIES.join(", ")} (got "${selected}")`
        );
      }
      return match;
    },
  });

const parsePositiveInt = (
  value: Option.Option<string>,
  flag: string
): Option.Option<number> =>
  Option.match(value, {
    onNone: () => Option.none(),
    onSome: (raw) => {
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${flag} must be a positive integer (got "${raw}")`);
      }
      return Option.some(parsed);
    },
  });

const ticketGraphError = (error: { readonly message: string }): Error =>
  new Error(error.message);

// ---------------------------------------------------------------------------
// Flag parsing — strict, with clear errors (no silent fallback to a default).
// ---------------------------------------------------------------------------

export const parseLoopFlags = (options: LoopCommandOptions): LoopFlags => {
  const maxMergePolls = parsePositiveInt(
    Option.fromNullishOr(options.mergeTimeout),
    "--merge-timeout"
  );
  const maxRemediationAttempts = parsePositiveInt(
    Option.fromNullishOr(options.maxRemediationAttempts),
    "--max-remediation-attempts"
  );
  return {
    ...Option.match(maxMergePolls, {
      onNone: () => ({}),
      onSome: (value) => ({ maxMergePolls: value }),
    }),
    ...Option.match(maxRemediationAttempts, {
      onNone: () => ({}),
      onSome: (value) => ({ maxRemediationAttempts: value }),
    }),
    rootId: options.root,
    strategy: parseStrategy(Option.fromNullishOr(options.strategy)),
  };
};

// ---------------------------------------------------------------------------
// Backlog precondition — cyclic or empty backlog refuses to start.
// ---------------------------------------------------------------------------

/**
 * Build the backlog graph and confirm there is at least one actionable ready
 * ticket. A cycle fails graph construction (surfaced verbatim); an empty or
 * fully-blocked backlog has no ready ticket and is refused — submitting a
 * controller with nothing to do is a user error, not a no-op success.
 */
const assertStartableBacklog = (
  tasks: readonly BacklogTaskRecord[],
  flags: LoopFlags
): Effect.Effect<void, Error> =>
  buildTicketGraphEffect([...tasks]).pipe(
    Effect.mapError(ticketGraphError),
    Effect.flatMap((graph) => {
      const ready = selectReadyTickets(graph, {
        rootId: flags.rootId,
        strategy: flags.strategy,
      });
      if (ready.length === 0) {
        return Effect.fail(
          new Error(
            "Backlog has no ready ticket to start the loop. Add or unblock a 'To Do' ticket whose dependencies are Done."
          )
        );
      }
      return Effect.void;
    })
  );

/** The argv the in-cluster pod runs to drive the loop. */
export const loopControllerArgv = (flags: LoopFlags): string[] => {
  const argv = ["moka", "loop-controller", "--strategy", flags.strategy];
  if (flags.rootId !== undefined) {
    argv.push("--root", flags.rootId);
  }
  if (flags.maxRemediationAttempts !== undefined) {
    argv.push(
      "--max-remediation-attempts",
      String(flags.maxRemediationAttempts)
    );
  }
  if (flags.maxMergePolls !== undefined) {
    argv.push("--merge-timeout", String(flags.maxMergePolls));
  }
  return argv;
};

const loopControllerSubmitInput = (
  input: LoopSubmitInput
): MokaSubmitInput => ({
  brokerAuth: input.brokerAuth,
  commandArgv: loopControllerArgv(input.flags),
  config: input.config,
  eventUrl: input.eventUrl,
  gitCredentialsSecretName: input.gitCredentialsSecretName,
  githubAuthSecretName: input.githubAuthSecretName,
  image: input.image,
  kubeconfigPath: input.kubeconfigPath,
  namespace: input.namespace,
  serviceAccountName: input.serviceAccountName,
  task: `moka loop (${input.flags.strategy})`,
  type: "command",
  worktreePath: input.worktreePath,
});

// ---------------------------------------------------------------------------
// Cloud submission — submit the controller as a long-running command workflow.
// ---------------------------------------------------------------------------

/**
 * Validate the backlog, then submit `moka loop-controller <flags>` as a cloud
 * command workflow. Returns the submitted workflow name.
 */
export const runLoopSubmit = async (
  input: LoopSubmitInput,
  seams: LoopCommandSeams = {}
): Promise<MokaSubmitResult> => {
  const loadTasks = seams.loadTasks ?? loadBacklogRecords;
  const submit = seams.submitMoka ?? submitMoka;
  return await Effect.runPromise(
    loadTasks(input.worktreePath).pipe(
      Effect.flatMap((tasks) =>
        assertStartableBacklog(tasks, input.flags).pipe(
          Effect.flatMap(() =>
            Effect.tryPromise({
              catch: (error) =>
                error instanceof Error ? error : new Error(String(error)),
              try: async () => await submit(loopControllerSubmitInput(input)),
            })
          )
        )
      )
    )
  );
};
