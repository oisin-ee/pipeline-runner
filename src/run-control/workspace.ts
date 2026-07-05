import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PIPELINE_DIR = ".pipeline";
const GITIGNORE_PATH = join(PIPELINE_DIR, ".gitignore");
const GITIGNORE_CONTENT = "*\n";

/**
 * Ensures `.pipeline/.gitignore` exists in `worktreePath` so that moka's
 * runtime artifacts are self-ignored and never picked up by lint/format tools
 * running inside the target repo.
 *
 * Idempotent: creates the file only if it does not already exist; never
 * overwrites an existing `.pipeline/.gitignore`.
 */
export const ensurePipelineWorkspaceIgnore = (worktreePath: string): void => {
  const pipelineDir = join(worktreePath, PIPELINE_DIR);
  const gitignorePath = join(worktreePath, GITIGNORE_PATH);

  if (existsSync(gitignorePath)) {
    return;
  }

  mkdirSync(pipelineDir, { recursive: true });
  writeFileSync(gitignorePath, GITIGNORE_CONTENT);
};
