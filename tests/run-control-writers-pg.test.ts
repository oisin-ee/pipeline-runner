import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  migratePostgresRunControlStore,
  postgresRunControlStore,
} from "../src/run-control/postgres/postgres-run-control-store";
import type { PostgresRunControlStore } from "../src/run-control/postgres/postgres-run-control-store";
import { resolveRunControlStore } from "../src/run-control/run-control-store";
import { createRunStoreRuntimeReporter } from "../src/run-control/runtime-reporter";
import { createRunControlSupervisor } from "../src/run-control/supervisor";

// PIPE-91.14: prove the live-run WRITER paths (supervisor, runtime-reporter, and
// the program createRun/updateRunController/writeNodeArtifact entrypoints) route
// through the RunControlStore seam. With db.url set the seam resolves to the
// Postgres store, so writer state must land in PG, NOT `.pipeline/runs`. The
// suite is infra-gated on MOKA_PG_TEST_URL (the port-forwarded cluster db.url),
// mirroring the 91.11/91.12 PG suites.
const PG_URL = process.env.MOKA_PG_TEST_URL ?? "";
const describePg = PG_URL ? describe : describe.skip;

const stateFilesExist = (workspaceRoot: string, runId: string): boolean => {
  const runRoot = join(workspaceRoot, ".pipeline", "runs", runId);
  return (
    existsSync(join(runRoot, "manifest.json")) ||
    existsSync(join(runRoot, "status.json")) ||
    existsSync(join(runRoot, "events.jsonl"))
  );
};

describePg(
  "run-control writers route through the db.url seam (live cluster PG)",
  () => {
    const dbUrl = PG_URL;
    const suitePrefix = `rcwriters-${Date.now()}-${Math.floor(
      Math.random() * 1e6
    )}`;
    const openStores: PostgresRunControlStore[] = [];
    let admin: postgres.Sql;
    let workspaceRoot: string;
    let counter = 0;

    const runId = (label: string): string => {
      counter += 1;
      return `${suitePrefix}-${label}-${counter}`;
    };

    const pgStore = (): PostgresRunControlStore => {
      const store = postgresRunControlStore(dbUrl);
      openStores.push(store);
      return store;
    };

    // AC2: read back from a FRESH seam resolution (the command path), proving
    // the writer-written state is visible exactly as `moka status/runs` see it.
    const readBackFromFreshResolution = async (id: string, root: string) =>
      await Effect.runPromise(
        Effect.scoped(
          resolveRunControlStore(dbUrl, root).pipe(
            Effect.flatMap((store) => store.readRun({ runId: id }))
          )
        )
      );

    beforeAll(async () => {
      vi.setConfig({ hookTimeout: 30_000, testTimeout: 20_000 });
      await migratePostgresRunControlStore(dbUrl);
      admin = postgres(dbUrl, { max: 1 });
    });

    afterAll(async () => {
      for (const store of openStores) {
        await store.close();
      }
      const like = `${suitePrefix}%`;
      await admin`delete from moka_run_control_node_artifact where run_id like ${like}`;
      await admin`delete from moka_run_control_node_session where run_id like ${like}`;
      await admin`delete from moka_run_control_event where run_id like ${like}`;
      await admin`delete from moka_run_control_run where run_id like ${like}`;
      await admin.end();
    });

    beforeEach(() => {
      workspaceRoot = mkdtempSync(join(tmpdir(), "moka-rc-writers-pg-"));
    });

    afterEach(() => {
      rmSync(workspaceRoot, { force: true, recursive: true });
    });

    it("reporter persists run/node/session state to PG, not the filesystem (AC1, AC2, AC3)", async () => {
      const id = runId("reporter");
      const store = pgStore();
      // program createRun entrypoint, via the resolved store.
      await Effect.runPromise(
        store.createRun({
          effort: "normal",
          mode: "write",
          nodeIds: ["writer"],
          runId: id,
          target: "local",
        })
      );

      const reporter = createRunStoreRuntimeReporter({
        runId: id,
        store,
        workspaceRoot,
      });

      reporter.reporter({
        nodeIds: ["writer"],
        type: "workflow.start",
        workflowId: "wf",
      });
      reporter.reporter({
        attempt: 1,
        nodeId: "writer",
        profile: "code-writer",
        runnerId: "opencode",
        type: "node.start",
      });
      reporter.reporter({
        nodeId: "writer",
        sessionId: "ses_writer",
        type: "node.session",
      });
      reporter.reporter({
        attempt: 1,
        exitCode: 0,
        nodeId: "writer",
        status: "passed",
        type: "node.finish",
      });
      reporter.reporter({
        outcome: "PASS",
        type: "workflow.finish",
        workflowId: "wf",
      });
      await reporter.flush();

      const manifest = await readBackFromFreshResolution(id, workspaceRoot);
      expect(manifest?.status).toBe("passed");
      expect(manifest?.nodes).toEqual({ writer: "passed" });

      // updateNodeSession landed in PG.
      const sessions = await admin`
        select session_id from moka_run_control_node_session
        where run_id = ${id} and node_id = 'writer'
      `;
      expect(sessions[0]?.session_id).toBe("ses_writer");

      // recordEvent (run/node status) rows landed in PG.
      const events = await admin`
        select count(*)::int as n from moka_run_control_event where run_id = ${id}
      `;
      expect(events[0]?.n).toBeGreaterThan(0);

      // Run-control STATE never touched `.pipeline/runs` (artifacts may, state
      // must not).
      expect(stateFilesExist(workspaceRoot, id)).toBe(false);
    });

    it("supervisor heartbeat + stall route through the PG store (AC1)", async () => {
      const id = runId("supervisor");
      const store = pgStore();
      await Effect.runPromise(
        store.createRun({
          effort: "quick",
          mode: "write",
          nodeIds: ["writer"],
          runId: id,
          target: "local",
        })
      );

      const supervisor = createRunControlSupervisor({
        heartbeatIntervalMs: 40,
        nodeStaleAfterMs: 40,
        now: () => new Date(),
        runId: id,
        store,
        workspaceRoot,
      });
      supervisor.start();
      supervisor.reporter({
        nodeIds: ["writer"],
        type: "workflow.start",
        workflowId: "wf",
      });
      supervisor.reporter({
        attempt: 1,
        nodeId: "writer",
        profile: "code-writer",
        runnerId: "opencode",
        type: "node.start",
      });

      await new Promise((resolve) => setTimeout(resolve, 250));
      await supervisor.stop();

      // updateNodeStatus("stalled") via the supervisor reached PG.
      const manifest = await readBackFromFreshResolution(id, workspaceRoot);
      expect(manifest?.nodes.writer).toBe("stalled");

      // recordEvent heartbeats via the supervisor reached PG.
      const heartbeats = await admin`
        select count(*)::int as n from moka_run_control_event
        where run_id = ${id} and (event->>'type') = 'run.heartbeat'
      `;
      expect(heartbeats[0]?.n).toBeGreaterThan(0);

      expect(stateFilesExist(workspaceRoot, id)).toBe(false);
    });

    it("writeNodeArtifact + updateRunController route through the PG store (AC1)", async () => {
      const id = runId("artifact");
      const store = pgStore();
      await Effect.runPromise(
        store.createRun({
          effort: "normal",
          mode: "write",
          nodeIds: ["writer"],
          runId: id,
          target: "local",
        })
      );

      const artifact = await Effect.runPromise(
        store.writeNodeArtifact({
          content: "hello\n",
          name: "stdout.jsonl",
          nodeId: "writer",
          runId: id,
        })
      );
      expect(artifact.path).toBe(
        `moka_run_control/${id}/nodes/writer/stdout.jsonl`
      );

      const rows = await admin`
        select content from moka_run_control_node_artifact
        where run_id = ${id} and node_id = 'writer' and name = 'stdout.jsonl'
      `;
      expect(rows[0]?.content).toBe("hello\n");

      await Effect.runPromise(
        store.updateRunController({
          controller: {
            argv: ["moka", "run"],
            cwd: workspaceRoot,
            paths: store.statusPaths({ runId: id }),
            pid: 4242,
            startedAt: new Date().toISOString(),
          },
          runId: id,
        })
      );

      const manifest = await readBackFromFreshResolution(id, workspaceRoot);
      expect(manifest?.controller?.pid).toBe(4242);
      expect(stateFilesExist(workspaceRoot, id)).toBe(false);
    });
  }
);
