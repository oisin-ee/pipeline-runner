import type { InstallCommandsResult } from "./shared";

export function formatInstallCommandsResult(
  result: InstallCommandsResult
): string {
  return result.items
    .map(
      (item) => `${item.action} ${item.host}: ${item.path} (${item.invocation})`
    )
    .join("\n");
}
