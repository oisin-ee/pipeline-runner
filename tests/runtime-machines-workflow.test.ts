import { describe, expect, it } from "vitest";
import { createActor } from "xstate";
import { parsePipelineConfigParts } from "../src/config.js";
import type { PipelineRuntimeResult } from "../src/pipeline-runtime.js";
import { runtimeActorId } from "../src/runtime-machines/contracts.js";
import { workflowSchedulerMachine } from "../src/runtime-machines/workflow-machine.js";
import { compileWorkflowPlan } from "../src/workflow-planner.js";

describe("workflowSchedulerMachine", () => {
  it("owns workflow execution by invoking the configured workflow run actor", async () => {
    const plan = compileWorkflowPlan(
      parsePipelineConfigParts({
        pipeline: `
version: 1
default_workflow: default
orchestrator:
  profile: orchestrator
workflows:
  default:
    nodes:
      - id: a
        kind: command
        command: [echo, ok]
`,
        profiles:
          "version: 1\nprofiles:\n  orchestrator:\n    runner: command\n    instructions: { inline: Orchestrate }\n",
        runners:
          "version: 1\nrunners:\n  command:\n    type: command\n    command: echo\n    capabilities:\n      native_subagents: false\n      output_formats: [text]\n",
      })
    );
    const result: PipelineRuntimeResult = {
      agentInvocations: [],
      failureDetails: [],
      gates: [],
      hookFailures: [],
      nodeStates: {},
      nodes: [
        {
          attempts: 1,
          evidence: [],
          exitCode: 0,
          nodeId: "a",
          output: "ok",
          status: "passed",
        },
      ],
      outcome: "PASS",
      plan,
    };
    let invoked = 0;
    const actor = createActor(workflowSchedulerMachine, {
      input: {
        actor: {
          id: runtimeActorId("workflow", { workflowId: "default" }),
          kind: "workflow",
        },
        failFast: false,
        nodeIds: ["a"],
        runWorkflow: () => {
          invoked += 1;
          return result;
        },
      },
    });

    actor.start();
    actor.send({ type: "START" });

    await expect(
      new Promise<void>((resolve) => {
        const sub = actor.subscribe((snapshot) => {
          if (snapshot.status === "done") {
            sub.unsubscribe();
            resolve();
          }
        });
      })
    ).resolves.toBeUndefined();

    expect(invoked).toBe(1);
    expect(actor.getSnapshot().value).toBe("passed");
    expect(actor.getSnapshot().context.result).toBe(result);
  });
});
