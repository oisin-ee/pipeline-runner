import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { InstallCommandsPlan, InstallPlanWrite } from "./planner";
import type { CommandDefinition, InstallCommandsOptions } from "./shared";

interface BlockReplacement {
  end: number;
  start: number;
}

function upsertGeneratedBlock(
  current: string,
  content: string,
  block: NonNullable<CommandDefinition["block"]>
): string {
  const replacement = blockReplacement(current, block);
  if (replacement) {
    return `${current.slice(0, replacement.start)}${content}${current.slice(replacement.end)}`;
  }
  const separator = current.trimEnd().length > 0 ? "\n\n" : "";
  return `${current.trimEnd()}${separator}${content}`;
}

function blockReplacement(
  current: string,
  block: NonNullable<CommandDefinition["block"]>
): BlockReplacement | undefined {
  const startIndex = current.indexOf(block.start);
  const endIndex = current.indexOf(block.end);
  if (startIndex < 0 || endIndex < startIndex) {
    return;
  }
  const afterEnd = endIndex + block.end.length;
  const lineEnd = current.indexOf("\n", afterEnd);
  return {
    end: lineEnd >= 0 ? lineEnd + 1 : afterEnd,
    start: startIndex,
  };
}

function shouldSkipInstallWrite(
  options: InstallCommandsOptions,
  write: InstallPlanWrite
): boolean {
  return Boolean(
    options.check ||
      options.dryRun ||
      write.action === "unchanged" ||
      write.action === "conflict"
  );
}

async function writePlanItem(write: InstallPlanWrite): Promise<void> {
  await mkdir(dirname(write.target), { recursive: true });
  if (write.block && existsSync(write.target)) {
    await writeFile(
      write.target,
      upsertGeneratedBlock(
        readFileSync(write.target, "utf8"),
        write.content,
        write.block
      )
    );
    return;
  }
  await writeFile(write.target, write.content);
}

function shouldRemoveObsoleteItems(options: InstallCommandsOptions): boolean {
  return !(options.check || options.dryRun);
}

async function removeObsoleteItems(
  plan: InstallCommandsPlan,
  options: InstallCommandsOptions
): Promise<void> {
  if (!shouldRemoveObsoleteItems(options)) {
    return;
  }
  for (const deletion of plan.deletes) {
    await rm(deletion.target, { force: true });
  }
}

export async function writeInstallPlan(
  plan: InstallCommandsPlan,
  options: InstallCommandsOptions
): Promise<void> {
  for (const write of plan.writes) {
    if (!shouldSkipInstallWrite(options, write)) {
      await writePlanItem(write);
    }
  }
  await removeObsoleteItems(plan, options);
}
