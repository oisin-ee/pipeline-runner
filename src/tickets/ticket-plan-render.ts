import type { TicketPlan, TicketPlanEpic, TicketPlanTask } from "./ticket-plan";
import { ticketCreateArgs } from "./ticket-plan-command-args";

const SAFE_SHELL_ARG_RE = /^[A-Za-z0-9_./:=@+-]+$/;

export function renderTicketPlanDryRun(plan: TicketPlan): string {
  return [
    "# Dry run: no Backlog files were written.",
    ...(plan.epic ? [renderCreateCommand(plan.epic)] : []),
    ...plan.tickets.map((ticket) =>
      renderCreateCommand(ticket, plan.epic?.key)
    ),
  ].join("\n");
}

function renderCreateCommand(
  task: TicketPlanEpic | TicketPlanTask,
  parentKey?: string
): string {
  return renderCommand([
    "backlog",
    ...ticketCreateArgs(task, { parentId: parentKey }),
  ]);
}

function renderCommand(args: readonly string[]): string {
  return args.map(shellArg).join(" ");
}

function shellArg(value: string): string {
  if (SAFE_SHELL_ARG_RE.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
