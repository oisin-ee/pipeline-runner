import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { Option } from "effect/Option";
import { isSome, none, some } from "effect/Option";

import type { InstallCommandsPlan, InstallPlanWrite } from "./planner";
import type { CommandDefinition, InstallCommandsOptions } from "./shared";

interface BlockReplacement {
  end: number;
  start: number;
}

const blockReplacement = (
  current: string,
  block: NonNullable<CommandDefinition["block"]>
): Option<BlockReplacement> => {
  const startIndex = current.indexOf(block.start);
  const endIndex = current.indexOf(block.end);
  if (startIndex === -1 || endIndex < startIndex) {
    return none();
  }
  const afterEnd = endIndex + block.end.length;
  const lineEnd = current.indexOf("\n", afterEnd);
  return some({
    end: lineEnd === -1 ? afterEnd : lineEnd + 1,
    start: startIndex,
  });
};

const upsertGeneratedBlock = (
  current: string,
  content: string,
  block: NonNullable<CommandDefinition["block"]>
): string => {
  const replacement = blockReplacement(current, block);
  if (isSome(replacement)) {
    return `${current.slice(0, replacement.value.start)}${content}${current.slice(replacement.value.end)}`;
  }
  const separator = current.trimEnd().length > 0 ? "\n\n" : "";
  return `${current.trimEnd()}${separator}${content}`;
};

const shouldSkipInstallWrite = (
  options: InstallCommandsOptions,
  write: InstallPlanWrite
): boolean =>
  Boolean(
    options.check === true ||
    options.dryRun === true ||
    write.action === "unchanged" ||
    write.action === "conflict"
  );

const writePlanItem = async (write: InstallPlanWrite): Promise<void> => {
  await mkdir(dirname(write.target), { recursive: true });
  if (write.block && existsSync(write.target)) {
    await writeFile(
      write.target,
      upsertGeneratedBlock(
        readFileSync(write.target, "utf-8"),
        write.content,
        write.block
      )
    );
    return;
  }
  await writeFile(write.target, write.content);
};

const shouldRemoveObsoleteItems = (options: InstallCommandsOptions): boolean =>
  options.check !== true && options.dryRun !== true;

const removeObsoleteItems = async (
  plan: InstallCommandsPlan,
  options: InstallCommandsOptions
): Promise<void> => {
  if (!shouldRemoveObsoleteItems(options)) {
    return;
  }
  for (const deletion of plan.deletes) {
    await rm(deletion.target, { force: true });
  }
};

export const writeInstallPlan = async (
  plan: InstallCommandsPlan,
  options: InstallCommandsOptions
): Promise<void> => {
  for (const write of plan.writes) {
    if (!shouldSkipInstallWrite(options, write)) {
      await writePlanItem(write);
    }
  }
  await removeObsoleteItems(plan, options);
};
