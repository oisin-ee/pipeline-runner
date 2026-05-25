import { describe, expect, it } from "vitest";
import { parseTicketAndDescription } from "../src/mastra/tickets.js";

describe("parseTicketAndDescription", () => {
  it("extracts ticket id and remainder", () => {
    expect(parseTicketAndDescription("PIPE-42 add NOOP fn")).toEqual({
      ticketId: "PIPE-42",
      description: "add NOOP fn",
    });
  });

  it("handles ticket-only input", () => {
    expect(parseTicketAndDescription("PIPE-42")).toEqual({
      ticketId: "PIPE-42",
      description: "PIPE-42",
    });
  });

  it("returns null ticket id when no prefix", () => {
    expect(parseTicketAndDescription("ad-hoc task description")).toEqual({
      ticketId: null,
      description: "ad-hoc task description",
    });
  });
});
