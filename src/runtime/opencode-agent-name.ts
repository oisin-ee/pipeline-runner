const MOKA_PROFILE_PREFIX = "moka-";

const opencodeAgentNamePart = (part: string): string => {
  if (part === "opencode") {
    return "OpenCode";
  }
  return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
};

/**
 * Map a pipeline profile id to the opencode agent name a served instance
 * exposes (e.g. `moka-code-writer` -> `MoKa Code Writer`). Shared by the slash
 * command installer and the SDK runtime so per-message agent selection targets
 * the same `.opencode/agent/*` definition the host projects.
 */
export const opencodeAgentName = (profileId: string): string => {
  if (!profileId.startsWith(MOKA_PROFILE_PREFIX)) {
    return profileId;
  }
  const displayName = profileId
    .slice(MOKA_PROFILE_PREFIX.length)
    .split("-")
    .map(opencodeAgentNamePart)
    .join(" ");
  return `MoKa ${displayName}`;
};
