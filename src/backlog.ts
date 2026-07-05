/**
 * `backlog task create` (with `--plain`) prints `Task <PREFIX>-<id> - <title>`
 * on the second non-blank line. We accept custom all-caps Backlog prefixes and
 * subtask ids like `PIPE-3.1`.
 */
const TASK_ID_RE = /^Task\s+([A-Z]+-[\w.]+)\b/mu;

export const parseBacklogTaskId = (stdout: string): Option.Option<string> => {
  const m = TASK_ID_RE.exec(stdout);
  return m === null ? Option.none() : Option.some(m[1]);
};
import { Option } from "effect";
