import {
  type CommandHostSelection,
  INSTALL_HOSTS,
  type InstallHost,
} from "./shared";

function isInstallHost(host: string): host is InstallHost {
  return INSTALL_HOSTS.some((candidate) => candidate === host);
}

export function parseCommandHost(
  value: string | undefined
): CommandHostSelection {
  const host = value ?? "all";
  if (host === "all") {
    return host;
  }
  if (isInstallHost(host)) {
    return host;
  }
  throw new Error(
    `Unsupported host "${host}". Supported values: all, ${INSTALL_HOSTS.join(", ")}.`
  );
}
