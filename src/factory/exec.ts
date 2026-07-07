import { execa } from "execa";

import { runAuthenticatedGit } from "../run-state/git-refs";

/**
 * Factory lanes (create-experiment / template-update) shell out to `copier`,
 * `gh` and `git`. The non-git seams mirror the loop lane's `GhExec` shape
 * (src/loop/gh-runner.ts) so tests inject fakes without spawning processes.
 *
 * Git is NOT a raw seam: every git operation routes through
 * `runAuthenticatedGit` (src/run-state/git-refs.ts), the one git-auth
 * primitive that wires the runner's mounted credential store and
 * GIT_TERMINAL_PROMPT=0. Outside a runner pod (no mounted credentials) it
 * degrades to ambient auth, which is what local development wants.
 */
export type FactoryExec = (
  command: string,
  args: readonly string[],
  options?: {
    readonly cwd?: string;
    /** Extra env merged onto the child's inherited environment (e.g. copier's github.com credential). */
    readonly env?: Readonly<Record<string, string>>;
  }
) => Promise<{ readonly stdout: string }>;

export type FactoryGit = (cwd: string, args: string[]) => Promise<string>;

export type FactoryLog = (line: string) => void;

const defaultFactoryExec: FactoryExec = async (command, args, options) =>
  // extendEnv defaults to true, so options.env is merged onto process.env for
  // the child only (and inherited by grandchildren — copier's git subprocess).
  await execa(command, [...args], {
    ...(options?.cwd !== undefined && options.cwd.length > 0
      ? { cwd: options.cwd }
      : {}),
    ...(options?.env === undefined ? {} : { env: options.env }),
    stdin: "ignore",
  });

const defaultFactoryGit: FactoryGit = async (cwd, args) =>
  await runAuthenticatedGit(cwd, args);

export interface FactorySeams {
  readonly exec?: FactoryExec;
  readonly git?: FactoryGit;
  readonly log?: FactoryLog;
}

export interface ResolvedFactorySeams {
  readonly exec: FactoryExec;
  readonly git: FactoryGit;
  readonly log: FactoryLog;
}

export const resolveFactorySeams = (
  seams: FactorySeams = {}
): ResolvedFactorySeams => ({
  exec: seams.exec ?? defaultFactoryExec,
  git: seams.git ?? defaultFactoryGit,
  // Lane progress lines ARE the runner Job log — the acceptance-evidence channel.
  log:
    seams.log ??
    (() => {
      /* empty */
    }),
});
