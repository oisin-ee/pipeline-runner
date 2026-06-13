import type { PipelineConfig, ScheduleBaseline } from "../config";
import type { ScheduleArtifact } from "../planning/generate";

const SCHEDULE_KIND = "pipeline-schedule";

export function baselineScheduleArtifact(input: {
  baseline: ScheduleBaseline;
  config: PipelineConfig;
  entrypointId: string;
  generatedAt: Date;
  runId?: string;
  task: string;
}): ScheduleArtifact {
  const scheduleId = input.runId ?? defaultScheduleId(input.generatedAt);
  const baseline = baselineWorkflows(input.baseline, input.config);
  return {
    generated_at: input.generatedAt.toISOString(),
    kind: SCHEDULE_KIND,
    root_workflow: baseline.rootWorkflow,
    schedule_id: scheduleId,
    source_entrypoint: input.entrypointId,
    task: input.task,
    version: 1,
    workflows: baseline.workflows,
  };
}

function baselineWorkflows(
  baseline: ScheduleBaseline,
  _config: PipelineConfig
): { rootWorkflow: string; workflows: ScheduleArtifact["workflows"] } {
  if (baseline === "quick") {
    return { rootWorkflow: "root", workflows: quickBaselineWorkflow() };
  }

  return { rootWorkflow: "root", workflows: executeBaselineWorkflow() };
}

function quickBaselineWorkflow(): ScheduleArtifact["workflows"] {
  return {
    root: {
      description: "Compact generated quick schedule seed.",
      nodes: [
        { id: "backlog-intake", kind: "agent", profile: "moka-researcher" },
        {
          id: "red-tests",
          kind: "agent",
          needs: ["backlog-intake"],
          profile: "moka-test-writer",
        },
        {
          id: "implement",
          kind: "agent",
          needs: ["red-tests"],
          profile: "moka-code-writer",
        },
        {
          builtin: "test",
          id: "mechanical-tests",
          kind: "builtin",
          needs: ["implement"],
        },
        {
          builtin: "typecheck",
          id: "mechanical-typecheck",
          kind: "builtin",
          needs: ["implement"],
        },
        {
          gates: [
            { builtin: "typecheck", id: "verify-typecheck", kind: "builtin" },
            { builtin: "test", id: "verify-tests", kind: "builtin" },
            { builtin: "lint", id: "verify-lint", kind: "builtin" },
            { builtin: "fallow", id: "verify-fallow", kind: "builtin" },
            { kind: "verdict", id: "verify-verdict", target: "stdout" },
          ],
          id: "verify",
          kind: "agent",
          needs: ["mechanical-tests", "mechanical-typecheck"],
          profile: "moka-verifier",
        },
      ],
    },
  };
}

function executeBaselineWorkflow(): ScheduleArtifact["workflows"] {
  return {
    root: {
      description: "Full generated execute schedule seed.",
      nodes: [
        {
          id: "backlog-intake",
          kind: "agent",
          profile: "moka-researcher",
        },
        {
          id: "research",
          kind: "agent",
          needs: ["backlog-intake"],
          profile: "moka-researcher",
        },
        {
          gates: [
            {
              changed_files: {
                allow: [
                  "**/*.test.*",
                  "**/*.spec.*",
                  "**/*_test.*",
                  "**/__tests__/**",
                  "test/**",
                  "tests/**",
                  "**/*.snap",
                ],
                require_any: [
                  "**/*.test.*",
                  "**/*.spec.*",
                  "**/*_test.*",
                  "**/__tests__/**",
                  "test/**",
                  "tests/**",
                ],
              },
              id: "red-test-file-policy",
              kind: "changed_files",
            },
          ],
          id: "red-tests",
          kind: "agent",
          needs: ["research"],
          profile: "moka-test-writer",
        },
        {
          id: "green-implementation",
          kind: "agent",
          needs: ["red-tests"],
          profile: "moka-code-writer",
        },
        {
          builtin: "test",
          id: "mechanical-green-tests",
          kind: "builtin",
          needs: ["green-implementation"],
        },
        {
          builtin: "typecheck",
          id: "mechanical-green-typecheck",
          kind: "builtin",
          needs: ["green-implementation"],
        },
        {
          builtin: "lint",
          id: "mechanical-green-lint",
          kind: "builtin",
          needs: ["green-implementation"],
        },
        {
          builtin: "fallow",
          id: "mechanical-green-fallow",
          kind: "builtin",
          needs: ["green-implementation"],
        },
        {
          gates: [
            {
              id: "acceptance-coverage",
              kind: "acceptance",
              required: false,
              target: "stdout",
            },
            { id: "acceptance-verdict", kind: "verdict", target: "stdout" },
          ],
          id: "acceptance-review",
          kind: "agent",
          needs: [
            "mechanical-green-tests",
            "mechanical-green-typecheck",
            "mechanical-green-lint",
            "mechanical-green-fallow",
          ],
          profile: "moka-acceptance-reviewer",
        },
        {
          gates: [
            { builtin: "typecheck", id: "verify-typecheck", kind: "builtin" },
            { builtin: "test", id: "verify-tests", kind: "builtin" },
            { builtin: "lint", id: "verify-lint", kind: "builtin" },
            { builtin: "fallow", id: "verify-fallow", kind: "builtin" },
            { builtin: "semgrep", id: "verify-semgrep", kind: "builtin" },
            {
              builtin: "duplication",
              id: "verify-duplication",
              kind: "builtin",
            },
            { id: "verify-verdict", kind: "verdict", target: "stdout" },
          ],
          id: "verification",
          kind: "agent",
          needs: [
            "mechanical-green-tests",
            "mechanical-green-typecheck",
            "mechanical-green-lint",
            "mechanical-green-fallow",
          ],
          profile: "moka-verifier",
        },
        {
          id: "code-quality-review",
          kind: "agent",
          needs: [
            "mechanical-green-tests",
            "mechanical-green-typecheck",
            "mechanical-green-lint",
            "mechanical-green-fallow",
          ],
          profile: "moka-thermo-nuclear-reviewer",
        },
        {
          id: "learn",
          kind: "agent",
          needs: ["acceptance-review", "verification", "code-quality-review"],
          profile: "moka-learner",
        },
      ],
    },
  };
}

function defaultScheduleId(date: Date): string {
  return `run-${date
    .toISOString()
    .replaceAll(/[-:.TZ]/g, "")
    .slice(0, 14)}`;
}
