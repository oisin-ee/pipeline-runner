import { describe, expect, it } from "vitest";
import {
  extractTicketIds,
  parseTicketAndDescription,
} from "../src/task-ref.js";

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

  it("keeps dotted child ticket ids intact", () => {
    expect(parseTicketAndDescription("PIPE-41.7 propagate context")).toEqual({
      ticketId: "PIPE-41.7",
      description: "propagate context",
    });
  });

  it("returns null ticket id when no prefix", () => {
    expect(parseTicketAndDescription("ad-hoc task description")).toEqual({
      ticketId: null,
      description: "ad-hoc task description",
    });
  });
});

describe("extractTicketIds", () => {
  it("extracts every unique ticket reference from free-form task text", () => {
    expect(
      extractTicketIds("Execute PIPE-50 and PIPE-51, then re-check PIPE-50.1")
    ).toEqual(["PIPE-50", "PIPE-51", "PIPE-50.1"]);
  });

  it("deduplicates repeated ticket references in first-seen order", () => {
    expect(extractTicketIds("PIPE-50 PIPE-51 PIPE-50")).toEqual([
      "PIPE-50",
      "PIPE-51",
    ]);
  });
});
