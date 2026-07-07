import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const resolveFileReference = (
  basePath: string,
  pathRef: string
): string => {
  if (pathRef === "~") {
    return homedir();
  }
  if (pathRef.startsWith("~/")) {
    return join(homedir(), pathRef.slice(2));
  }
  if (isAbsolute(pathRef)) {
    return pathRef;
  }
  return join(basePath, pathRef);
};
