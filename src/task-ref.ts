const NO_TICKET_ID = null;

interface TicketResult {
  description: string;
  ticketId: string | typeof NO_TICKET_ID;
}

const TICKET_ID_SOURCE = String.raw`(?=[A-Za-z0-9.-]*\d)[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+(?:\.[A-Za-z0-9]+)*`;
const TICKET_RE = new RegExp(`^(${TICKET_ID_SOURCE})\\b\\s*(.*)$`, "su");
const TICKET_ID_RE = new RegExp(`\\b(${TICKET_ID_SOURCE})\\b`, "gu");

/**
 * Extract a Backlog.md ticket id (e.g. "PIPE-42") from the start of a free-form
 * description string. Returns the id and the remaining description.
 */
export const parseTicketAndDescription = (input: string): TicketResult => {
  const m = input.match(TICKET_RE);
  if (m !== null) {
    const description = m[2].trim();
    return {
      description: description.length > 0 ? description : m[1],
      ticketId: m[1],
    };
  }
  return { description: input, ticketId: NO_TICKET_ID };
};

export const extractTicketIds = (input: string): string[] => {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of input.matchAll(TICKET_ID_RE)) {
    const id = match[1];
    if (id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
};
