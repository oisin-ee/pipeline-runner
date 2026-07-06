import type { TicketPlan, TicketPlanEpic, TicketPlanTask } from "./ticket-plan";
import { ticketCreateArgs } from "./ticket-plan-command-args";

const SAFE_SHELL_ARG_RE = /^[A-Za-z0-9_./:=@+-]+$/u;

const shellArg = (value: string): string => {
  if (SAFE_SHELL_ARG_RE.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
};

const renderCommand = (args: readonly string[]): string => args.map(shellArg).join(" ");

const renderCreateCommand = (task: TicketPlanEpic | TicketPlanTask, parentKey?: string): string =>
  renderCommand(["backlog", ...ticketCreateArgs(task, { parentId: parentKey })]);

export const renderTicketPlanDryRun = (plan: TicketPlan): string =>
  [
    "# Dry run: no Backlog files were written.",
    ...(plan.epic ? [renderCreateCommand(plan.epic)] : []),
    ...plan.tickets.map((ticket) => renderCreateCommand(ticket, plan.epic?.key)),
  ].join("\n");
