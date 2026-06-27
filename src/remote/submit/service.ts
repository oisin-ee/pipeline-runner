import { randomBytes } from "node:crypto";
import {
  type MokaWorkflowSubmit,
  submitCompiledMokaWorkflow,
} from "./argo-submission";
import {
  compileMokaSubmitPlan,
  type MokaSubmitCompilationDependencies,
} from "./compilation";
import type {
  MokaSubmitOutput,
  ParsedMokaSubmitOptions,
  ParsedMokaWithRun,
} from "./contract";
import { type MokaSubmitIoDependencies, resolveSubmissionContext } from "./io";

export interface SubmitMokaDependencies
  extends MokaSubmitCompilationDependencies,
    MokaSubmitIoDependencies {
  generateRunId?: () => string;
  submitWorkflow?: MokaWorkflowSubmit;
}

export async function submitParsedMoka(
  options: ParsedMokaSubmitOptions,
  dependencies: SubmitMokaDependencies = {}
): Promise<MokaSubmitOutput> {
  const runId = submitRunId(options, dependencies);
  const context = await resolveSubmissionContext(options, dependencies, runId);
  const plan = await compileMokaSubmitPlan({ dependencies, options, runId });
  return submitCompiledMokaWorkflow({
    context,
    options,
    plan,
    submitWorkflow: dependencies.submitWorkflow,
  });
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
