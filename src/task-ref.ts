interface TicketResult {
  description: string;
  ticketId: string | null;
}

const TICKET_RE = /^([A-Z]+-\d+)\b\s*(.*)$/s;

/**
 * Extract a Backlog.md ticket id (e.g. "PIPE-42") from the start of a free-form
 * description string. Returns the id and the remaining description.
 */
export function parseTicketAndDescription(input: string): TicketResult {
  const m = input.match(TICKET_RE);
  if (m) {
    return {
      ticketId: m[1] ?? null,
      description: (m[2] ?? "").trim() || (m[1] ?? ""),
    };
  }
  return { ticketId: null, description: input };
}
