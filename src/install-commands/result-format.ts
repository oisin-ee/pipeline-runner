import type { InstallCommandsResult } from "./shared";

export const formatInstallCommandsResult = (
  result: InstallCommandsResult
): string =>
  result.items
    .map(
      (item) => `${item.action} ${item.host}: ${item.path} (${item.invocation})`
    )
    .join("\n");
