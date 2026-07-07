import { describe, expect, it } from "vitest";

import { extractTicketIds, parseTicketAndDescription } from "../src/task-ref";

describe("parseTicketAndDescription", () => {
  it("extracts ticket id and remainder", () => {
    expect(parseTicketAndDescription("PIPE-42 add NOOP fn")).toEqual({
      description: "add NOOP fn",
      ticketId: "PIPE-42",
    });
  });

  it("extracts lowercase Backlog ticket ids", () => {
    expect(parseTicketAndDescription("jalgpall-2 Adopt pg-boss queue")).toEqual(
      {
        description: "Adopt pg-boss queue",
        ticketId: "jalgpall-2",
      }
    );
  });

  it("handles ticket-only input", () => {
    expect(parseTicketAndDescription("PIPE-42")).toEqual({
      description: "PIPE-42",
      ticketId: "PIPE-42",
    });
  });

  it("keeps dotted child ticket ids intact", () => {
    expect(parseTicketAndDescription("PIPE-41.7 propagate context")).toEqual({
      description: "propagate context",
      ticketId: "PIPE-41.7",
    });
  });

  it("returns null ticket id when no prefix", () => {
    expect(parseTicketAndDescription("ad-hoc task description")).toEqual({
      description: "ad-hoc task description",
      ticketId: null,
    });
  });
});

describe("extractTicketIds", () => {
  it("extracts every unique ticket reference from free-form task text", () => {
    expect(
      extractTicketIds("Execute PIPE-50 and PIPE-51, then re-check PIPE-50.1")
    ).toEqual(["PIPE-50", "PIPE-51", "PIPE-50.1"]);
  });

  it("extracts lowercase and alphanumeric Backlog ticket references", () => {
    expect(
      extractTicketIds(
        "Schedule jalgpall-2 with jalgpall-2mk and jalgpall-e82.8"
      )
    ).toEqual(["jalgpall-2", "jalgpall-2mk", "jalgpall-e82.8"]);
  });

  it("deduplicates repeated ticket references in first-seen order", () => {
    expect(extractTicketIds("PIPE-50 jalgpall-2 PIPE-50")).toEqual([
      "PIPE-50",
      "jalgpall-2",
    ]);
  });
});
