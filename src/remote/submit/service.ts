import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import { loadMokaDbUrl } from "../../moka-global-config";
import type {
  MokaSubmitOutput,
  ParsedMokaSubmitOptions,
  ParsedMokaWithRun,
} from "../../moka-submit";
import { resolveRunControlStore } from "../../run-control/run-control-store";
import { buildRemoteRunCreateRequest } from "../../run-control/run-record";
import {
  type MokaWorkflowSubmit,
  submitCompiledMokaWorkflow,
} from "./argo-submission";
import {
  type CompiledMokaSubmitPlan,
  compileMokaSubmitPlan,
  type MokaSubmitCompilationDependencies,
} from "./compilation";
import { type MokaSubmitIoDependencies, resolveSubmissionContext } from "./io";

export interface SubmitMokaDependencies
  extends MokaSubmitCompilationDependencies,
    MokaSubmitIoDependencies {
  generateRunId?: () => string;
  submitWorkflow?: MokaWorkflowSubmit;
  /**
   * PIPE-94.4: injectable override for the pre-submit createRun upsert.
   *
   * Default: {@link defaultUpsertRunRecord} — calls loadMokaDbUrl(), resolves
   * the run-control store, and calls createRun with the compiled plan. Absent
   * db.url or any store failure is logged and silently skipped so Argo submission
   * always proceeds (the in-pod runner lifecycle, PIPE-94.5, is the floor).
   *
   * Tests inject this to spy on the createRun call or simulate outages.
   */
  upsertRunRecord?: (
    plan: CompiledMokaSubmitPlan,
    worktreePath?: string
  ) => Promise<void>;
}

export async function submitParsedMoka(
  options: ParsedMokaSubmitOptions,
  dependencies: SubmitMokaDependencies = {}
): Promise<MokaSubmitOutput> {
  const runId = submitRunId(options, dependencies);
  const context = await resolveSubmissionContext(options, dependencies, runId);
  const plan = await compileMokaSubmitPlan({ dependencies, options, runId });
  const upsertRunRecord =
    dependencies.upsertRunRecord ?? defaultUpsertRunRecord;
  // PIPE-94.4: guard — a failing upsert must never block Argo submission.
  await upsertRunRecord(plan, options.worktreePath).catch((error) => {
    process.stderr.write(
      `moka submit: run record upsert threw unexpectedly — proceeding with Argo submission for run ${plan.runId}: ${error instanceof Error ? error.message : String(error)}\n`
    );
  });
  return submitCompiledMokaWorkflow({
    context,
    options,
    plan,
    submitWorkflow: dependencies.submitWorkflow,
  });
}

/**
 * PIPE-94.4: attempt to upsert a minimal run record (runId + schedule) into the
 * durable store BEFORE the Argo workflow is submitted, so `moka status`, `moka
 * next node`, and `moka resume` can find the run as "pending" immediately.
 *
 * Guard contract:
 *  - db.url absent → log + skip (the in-pod runner lifecycle floor covers it).
 *  - store call fails → log + skip (submission must not block on DB outage).
 *  - Never throws.
 *
 * nodeIds is [] at submit time — the runner lifecycle (PIPE-94.5) calls
 * createRun again (idempotent upsert from PIPE-94.1) with the real node list
 * once the schedule is compiled inside the pod.
 */
async function defaultUpsertRunRecord(
  plan: CompiledMokaSubmitPlan,
  worktreePath?: string
): Promise<void> {
  const dbUrl = loadMokaDbUrl();
  if (dbUrl === undefined) {
    process.stderr.write(
      `moka submit: db.url not configured — run ${plan.runId} will appear in durable store when the runner pod initialises\n`
    );
    return;
  }
  try {
    await Effect.runPromise(
      Effect.scoped(
        resolveRunControlStore(dbUrl, worktreePath ?? "").pipe(
          Effect.flatMap((store) =>
            store.createRun(
              buildRemoteRunCreateRequest({
                config: plan.config,
                runId: plan.runId,
                scheduleYaml: plan.scheduleYaml,
                worktreePath,
              })
            )
          )
        )
      )
    );
  } catch (error) {
    process.stderr.write(
      `moka submit: createRun failed (store may be unreachable) — submitting Argo workflow for run ${plan.runId} regardless: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}

function submitRunId(
  options: ParsedMokaWithRun,
  dependencies: SubmitMokaDependencies
): string {
  return options.run?.id ?? generateRunId(dependencies);
}

function generateRunId(dependencies: SubmitMokaDependencies): string {
  return (
    dependencies.generateRunId?.() ?? `run-${randomBytes(8).toString("hex")}`
  );
}
