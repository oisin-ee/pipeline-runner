interface TicketResult {
  description: string;
  ticketId: string | null;
}

const TICKET_RE = /^([A-Z]+-\d+(?:\.\d+)*)\b\s*(.*)$/s;
const TICKET_ID_RE = /\b([A-Z]+-\d+(?:\.\d+)*)\b/g;

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

export function extractTicketIds(input: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of input.matchAll(TICKET_ID_RE)) {
    const id = match[1];
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
