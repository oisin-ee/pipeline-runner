import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli/program";
import type { loadMokaDbUrl } from "../src/moka-global-config";
import { buildNextNodeEnvelope } from "../src/run-control/next-node";
import type { NodeEnvelopeMetadata } from "../src/run-control/next-node";
import {
  migratePostgresRunControlStore,
  postgresRunControlStore,
} from "../src/run-control/postgres/postgres-run-control-store";
import { recordSubmitResult } from "../src/run-control/submit-result";
import type { RuntimeNodeResult } from "../src/runtime/contracts";
import { resolveDurableStore } from "../src/runtime/durable-store/acquisition";
import type { DurableRunStore } from "../src/runtime/durable-store/durable-store";
import type { WorkflowScheduleNode } from "../src/runtime/scheduler";
import { setupLivePgDurableSuite } from "./live-pg-durable-suite";

// PIPE-91.15: the `moka next node` / `moka submit-result` CLIs must persist to
// Postgres when db.url is set so a result submitted in one process survives and
// is read back by a FRESH next-node in another process (cross-process stepping).
// Set MOKA_PG_TEST_URL to the (port-forwarded) cluster db.url to run the live
// suite; unset skips it so the default test run stays infra-free.
const PG_URL = process.env.MOKA_PG_TEST_URL ?? "";
const describePg = PG_URL ? describe : describe.skip;
const DB_URL_REQUIRED_RE = /db\.url-required.*momokaya\.db\.url/u;

vi.mock("../src/moka-global-config", async (importOriginal) => {
  const actual = await importOriginal<MokaGlobalConfigModule>();
  return {
    ...actual,
    loadMokaDbUrl: () => process.env.MOKA_PG_TEST_URL,
  };
});

// Two-node graph: plan → implement (implement depends on plan).
const nodes: WorkflowScheduleNode[] = [
  { dependents: ["implement"], id: "plan", index: 0, needs: [] },
  { dependents: [], id: "implement", index: 1, needs: ["plan"] },
];

const nodeMetadata: ReadonlyMap<string, NodeEnvelopeMetadata> = new Map([
  ["plan", { criteria: [], prompt: "Plan the work" }],
  ["implement", { criteria: [], prompt: "Implement" }],
]);

const passedResult = (nodeId: string): RuntimeNodeResult => ({
  attempts: 1,
  evidence: ["exit 0"],
  exitCode: 0,
  nodeId,
  output: `output of ${nodeId}`,
  status: "passed",
});

// Run one unit of work inside a freshly-resolved durable store scope. The store
// is acquired and (for the Postgres branch) flushed + closed when this Effect's
// scope exits — exactly the per-process lifecycle a `moka next node` / `moka
// submit-result` invocation has.
const withStore = async <A>(
  dbUrl: string | undefined,
  runId: string,
  use: (store: DurableRunStore) => A
): Promise<A> =>
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* effectBody() {
        const store = yield* resolveDurableStore(dbUrl, runId);
        return use(store);
      })
    )
  );

const scheduleYaml = (): string =>
  [
    "kind: pipeline-schedule",
    "version: 1",
    "schedule_id: db-next-node",
    "generated_at: 2026-06-27T00:00:00.000Z",
    "source_entrypoint: quick",
    "root_workflow: root",
    'task: "step from db"',
    "workflows:",
    "  root:",
    "    nodes:",
    "      - id: plan",
    "        kind: command",
    "        command: [node, -e, \"console.log('plan')\"]",
    "        task_context:",
    "          description: Plan the work",
    "      - id: implement",
    "        kind: command",
    "        command: [node, -e, \"console.log('implement')\"]",
    "        needs: [plan]",
    "        task_context:",
    "          description: Implement",
    "",
  ].join("\n");

const makeGitWorktree = (prefix: string): string => {
  const worktreePath = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "--quiet"], { cwd: worktreePath });
  return worktreePath;
};

const gitStatusPorcelain = (worktreePath: string): string[] =>
  execFileSync("git", ["status", "--porcelain"], {
    cwd: worktreePath,
    encoding: "utf-8",
  })
    .split("\n")
    .filter(Boolean);

const captureStdout = async <T>(run: () => Promise<T>): Promise<string> => {
  let stdout = "";
  const writeSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    });
  try {
    await run();
    return stdout;
  } finally {
    writeSpy.mockRestore();
  }
};

const runNextNodeCommand = async (
  runId: string,
  worktreePath: string
): Promise<string> => {
  const originalTargetPath = process.env.PIPELINE_TARGET_PATH;
  try {
    process.env.PIPELINE_TARGET_PATH = worktreePath;
    return await captureStdout(async () => {
      await runCli([
        "node",
        "/repo/node_modules/.bin/moka",
        "next",
        "node",
        runId,
      ]);
    });
  } finally {
    if (originalTargetPath === undefined) {
      delete process.env.PIPELINE_TARGET_PATH;
    } else {
      process.env.PIPELINE_TARGET_PATH = originalTargetPath;
    }
  }
};

const runSubmitResultCommand = async (
  runId: string,
  nodeId: string,
  result: RuntimeNodeResult
): Promise<void> => {
  await captureStdout(async () => {
    await runCli([
      "node",
      "/repo/node_modules/.bin/moka",
      "submit-result",
      runId,
      nodeId,
      "--json",
      JSON.stringify(result),
    ]);
  });
};

describe("resolveDurableStore selection (no infra)", () => {
  it("fails fast when db.url is absent instead of selecting the in-memory store", async () => {
    await expect(
      Effect.runPromise(Effect.scoped(resolveDurableStore(undefined, "run-1")))
    ).rejects.toThrow(DB_URL_REQUIRED_RE);
  });
});

describePg(
  "next-node ⇆ submit-result cross-process stepping (live cluster PG)",
  () => {
    const dbUrl = PG_URL;
    vi.setConfig({ hookTimeout: 90_000, testTimeout: 90_000 });
    const livePgDurableSuite = setupLivePgDurableSuite(dbUrl, "pgstep");
    const createdRunIds: string[] = [];
    let admin: postgres.Sql | undefined;

    const adminClient = (): postgres.Sql => {
      if (!admin) {
        throw new Error("Postgres admin client was not initialised.");
      }
      return admin;
    };

    beforeAll(async () => {
      await migratePostgresRunControlStore(dbUrl);
      admin = postgres(dbUrl, { max: 1 });
    });

    afterAll(async () => {
      if (!admin) {
        return;
      }
      const db = adminClient();
      for (const id of createdRunIds) {
        await db`delete from moka_run_control_node_artifact where run_id = ${id}`;
        await db`delete from moka_run_control_node_session where run_id = ${id}`;
        await db`delete from moka_run_control_event where run_id = ${id}`;
        await db`delete from moka_run_control_run where run_id = ${id}`;
      }
      await db.end();
      admin = undefined;
    });

    it("submit-result persists across a process boundary so a fresh next-node advances (AC2)", async () => {
      const id = livePgDurableSuite.runId("step");

      // Process 1 — next node: with nothing persisted, the first ready node is
      // "plan". This read alone persists nothing.
      const first = await withStore(dbUrl, id, (store) =>
        buildNextNodeEnvelope({ nodeMetadata, nodes, runId: id, store })
      );
      expect(first?.nodeId).toBe("plan");

      // Process 2 — submit-result for "plan": the scope exit flushes the
      // write-through and closes the client, persisting the record to Postgres.
      await withStore(dbUrl, id, (store) => {
        recordSubmitResult({
          nodeId: "plan",
          resultJson: JSON.stringify(passedResult("plan")),
          runId: id,
          store,
        });
      });

      // Process 3 — next node again: a brand-new store hydrates from Postgres and
      // must read back "plan" as settled, advancing to the dependent "implement"
      // with plan's output threaded through upstreamOutputs.
      const second = await withStore(dbUrl, id, (store) =>
        buildNextNodeEnvelope({ nodeMetadata, nodes, runId: id, store })
      );
      expect(second?.nodeId).toBe("implement");
      expect(second?.upstreamOutputs).toEqual([
        { nodeId: "plan", output: "output of plan" },
      ]);

      // The row physically exists in moka_durable_node_record for this run.
      const verificationAdmin = postgres(dbUrl, { max: 1 });
      try {
        const rows = await verificationAdmin<
          { node_id: string; status: string }[]
        >`
        select node_id, status
        from moka_durable_node_record
        where run_id = ${id}
      `;
        expect(rows).toEqual([{ node_id: "plan", status: "passed" }]);
      } finally {
        await verificationAdmin.end();
      }
    });

    it("command actions read manifest.schedule from the DB and advance across process boundaries (AC1, AC3)", async () => {
      const id = livePgDurableSuite.runId("db-schedule-step");
      createdRunIds.push(id);
      const worktreePath = makeGitWorktree("next-node-db-worktree-");
      const store = postgresRunControlStore(dbUrl);
      try {
        await Effect.runPromise(
          store.createRun({
            effort: "normal",
            mode: "write",
            nodeIds: ["plan", "implement"],
            runId: id,
            schedule: scheduleYaml(),
            target: "local",
          })
        );

        expect(
          JSON.parse(await runNextNodeCommand(id, worktreePath))
        ).toMatchObject({
          nodeId: "plan",
          prompt: "Plan the work",
          runId: id,
          upstreamOutputs: [],
        });

        await runSubmitResultCommand(id, "plan", passedResult("plan"));

        expect(
          JSON.parse(await runNextNodeCommand(id, worktreePath))
        ).toMatchObject({
          nodeId: "implement",
          prompt: "Implement",
          runId: id,
          upstreamOutputs: [{ nodeId: "plan", output: "output of plan" }],
        });

        expect(gitStatusPorcelain(worktreePath)).toEqual([]);

        const rows = await adminClient()<{ schedule: string }[]>`
        select manifest->>'schedule' as schedule
        from moka_run_control_run
        where run_id = ${id}
      `;
        expect(rows[0]?.schedule).toContain("kind: pipeline-schedule");
        expect(rows[0]?.schedule).toContain("db-next-node");
      } finally {
        await store.close();
        rmSync(worktreePath, { force: true, recursive: true });
      }
    });
  }
);

interface MokaGlobalConfigModule {
  loadMokaDbUrl: typeof loadMokaDbUrl;
}
