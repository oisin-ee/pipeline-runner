/**
 * `backlog task create` (with `--plain`) prints `Task <PREFIX>-<id> - <title>`
 * on the second non-blank line. We accept custom all-caps Backlog prefixes and
 * subtask ids like `PIPE-3.1`.
 */
const TASK_ID_RE = /^Task\s+([A-Z]+-[\w.]+)\b/m;

export function parseBacklogTaskId(stdout: string): string | null {
  const m = TASK_ID_RE.exec(stdout);
  return m ? m[1] : null;
}
