import { parseCommandHost } from "./install-commands/host-selection";
import { assertInstallPlanCurrent, planInstallCommands } from "./install-commands/planner";
import { formatInstallCommandsResult } from "./install-commands/result-format";
import type { InstallCommandsOptions, InstallCommandsResult } from "./install-commands/shared";
import { writeInstallPlan } from "./install-commands/writer";

export type { InstallCommandsOptions, InstallCommandsResult } from "./install-commands/shared";

const addInstallPlanSummary = (error: unknown, result: InstallCommandsResult): void => {
  if (!(error instanceof Error)) {
    return;
  }
  const summary = formatInstallCommandsResult(result);
  if (!summary) {
    return;
  }
  error.message = `${error.message}\n\nPlanned install changes:\n${summary}`;
};

export const installCommands = async (options: InstallCommandsOptions = {}): Promise<InstallCommandsResult> => {
  const normalizedOptions = {
    ...options,
    host: parseCommandHost(options.host),
  };
  const plan = await planInstallCommands(normalizedOptions);
  await writeInstallPlan(plan, normalizedOptions);
  const result = { items: plan.items };
  try {
    assertInstallPlanCurrent(normalizedOptions, plan);
  } catch (error) {
    addInstallPlanSummary(error, result);
    throw error;
  }
  return result;
};
