import { describe, expect, it, vi } from "@effect/vitest";
import { Option } from "effect";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { MokaSubmitOutput } from "../src/moka-submit";
import { resumeRunByOrigin } from "../src/pipeline-runtime";
import type { ResumeRunOptions } from "../src/pipeline-runtime";
import type { MokaRunManifest, RunTarget } from "../src/run-control/contracts";

// PIPE-94.8: origin-aware resume. `moka resume` reads the run's origin from the
// persisted manifest (`manifest.target`) and dispatches: local-origin continues
// in-process; remote-origin re-submits the SAME full schedule to Argo under the
// SAME runId (passed nodes are skipped in-pod from the durable store). These
// tests inject the routing seams so the dispatch is proven without Postgres or a
// live Argo cluster.

const manifest = (target: RunTarget, schedule?: string): MokaRunManifest => ({
  effort: "normal",
  events: [],
  mode: "write",
  nodes: { a: "passed", b: "queued" },
  runId: "run-origin",
  ...(schedule !== undefined && schedule.length > 0 ? { schedule } : {}),
  status: "running",
  target,
});

const options = (
  overrides: Partial<ResumeRunOptions> = {}
): ResumeRunOptions => ({
  dbUrl: "postgres://stub",
  runId: "run-origin",
  task: "drain the remaining nodes",
  worktreePath: "/tmp/resume-origin",
  ...overrides,
});

const NO_SCHEDULE_ERROR = /no schedule to rebuild the Argo workflow/u;

const SUBMISSION: MokaSubmitOutput = {
  namespace: "moka",
  payloadConfigMapName: "payload-cm",
  scheduleConfigMapName: "schedule-cm",
  taskDescriptorConfigMapName: "task-cm",
  workflowName: "moka-run-origin",
};

class MokaResumeOriginTestError extends Schema.TaggedErrorClass<MokaResumeOriginTestError>()(
  "MokaResumeOriginTestError",
  {
    cause: Schema.Unknown,
  }
) {}

const testPromise = <A>(
  evaluate: () => Promise<A>
): Effect.Effect<A, MokaResumeOriginTestError> =>
  Effect.tryPromise({
    catch: (cause) => new MokaResumeOriginTestError({ cause }),
    try: evaluate,
  });

describe("resumeRunByOrigin", () => {
  it.effect(
    "re-submits a remote-origin run to Argo with the persisted schedule (AC1)",
    () =>
      testPromise(async () => {
        const resubmit = vi.fn(async () => await Promise.resolve(SUBMISSION));
        const runLocal = vi.fn();

        const result = await resumeRunByOrigin(options(), {
          readManifest: async () =>
            await Promise.resolve(
              Option.some(manifest("remote", "schedule_id: persisted-graph"))
            ),
          resubmit,
          runLocal,
        });

        expect(result).toEqual({ kind: "remote", submission: SUBMISSION });
        expect(resubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            runId: "run-origin",
            scheduleYaml: "schedule_id: persisted-graph",
            task: "drain the remaining nodes",
            worktreePath: "/tmp/resume-origin",
          })
        );
        expect(runLocal).not.toHaveBeenCalled();
      })
  );

  it.effect(
    "continues a local-origin run in-process, never re-submitting (AC2)",
    () =>
      testPromise(async () => {
        const resubmit = vi.fn();
        const runLocal = vi.fn(() => {
          throw new Error("LOCAL_PATH_TAKEN");
        });

        await expect(
          resumeRunByOrigin(options(), {
            readManifest: async () =>
              await Promise.resolve(
                Option.some(manifest("local", "schedule_id: local-graph"))
              ),
            resubmit,
            runLocal,
          })
        ).rejects.toThrow("LOCAL_PATH_TAKEN");

        expect(runLocal).toHaveBeenCalledTimes(1);
        expect(resubmit).not.toHaveBeenCalled();
      })
  );

  it.effect(
    "falls back to local when db.url is absent (origin unknowable, AC2)",
    () =>
      testPromise(async () => {
        const readManifest = vi.fn();
        const resubmit = vi.fn();
        const runLocal = vi.fn(() => {
          throw new Error("LOCAL_PATH_TAKEN");
        });

        await expect(
          resumeRunByOrigin(options({ dbUrl: undefined }), {
            readManifest,
            resubmit,
            runLocal,
          })
        ).rejects.toThrow("LOCAL_PATH_TAKEN");

        expect(readManifest).not.toHaveBeenCalled();
        expect(resubmit).not.toHaveBeenCalled();
        expect(runLocal).toHaveBeenCalledTimes(1);
      })
  );

  it.effect(
    "fails clearly when a remote run has no persisted schedule to re-submit",
    () =>
      testPromise(async () => {
        const resubmit = vi.fn();
        const runLocal = vi.fn();

        await expect(
          resumeRunByOrigin(options(), {
            readManifest: async () =>
              await Promise.resolve(Option.some(manifest("remote"))),
            resubmit,
            runLocal,
          })
        ).rejects.toThrow(NO_SCHEDULE_ERROR);

        expect(resubmit).not.toHaveBeenCalled();
        expect(runLocal).not.toHaveBeenCalled();
      })
  );
});
