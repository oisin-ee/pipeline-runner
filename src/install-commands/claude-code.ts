import { readFileSync } from "node:fs";
import { resolvePackageAssetPath } from "../package-assets";
import {
  type CommandDefinition,
  GENERATED_MARKER,
  invocationForHost,
  OWNER_MARKER_PREFIX,
} from "./shared";

const CLAUDE_CODE_OPENCODE_EXECUTE_SKILL = "claude-code-opencode-execute";
const PACKAGE_SKILL_PATH = `.agents/skills/${CLAUDE_CODE_OPENCODE_EXECUTE_SKILL}/SKILL.md`;

function generatedClaudeSkillContent(): string {
  const source = readFileSync(
    resolvePackageAssetPath(PACKAGE_SKILL_PATH),
    "utf8"
  );
  return source.replace(
    "# Claude Code OpenCode Execute",
    [
      GENERATED_MARKER,
      `${OWNER_MARKER_PREFIX}host=claude-code -->`,
      "",
      "# Claude Code OpenCode Execute",
    ].join("\n")
  );
}

export function claudeCodeDefinitions(): CommandDefinition[] {
  return [
    {
      content: generatedClaudeSkillContent(),
      host: "claude-code" as const,
      invocation: invocationForHost(
        "claude-code",
        CLAUDE_CODE_OPENCODE_EXECUTE_SKILL
      ),
      path: `.claude/skills/${CLAUDE_CODE_OPENCODE_EXECUTE_SKILL}/SKILL.md`,
    },
  ];
}
