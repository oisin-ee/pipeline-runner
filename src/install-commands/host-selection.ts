import { INSTALL_HOSTS } from "./shared";
import type { CommandHostSelection, InstallHost } from "./shared";

const isInstallHost = (host: string): host is InstallHost =>
  INSTALL_HOSTS.some((candidate) => candidate === host);

export const parseCommandHost = (host = "all"): CommandHostSelection => {
  if (host === "all") {
    return host;
  }
  if (isInstallHost(host)) {
    return host;
  }
  throw new Error(
    `Unsupported host "${host}". Supported values: all, ${INSTALL_HOSTS.join(", ")}.`
  );
};
