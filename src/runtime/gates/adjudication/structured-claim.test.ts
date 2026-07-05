import { describe, expect, it } from "vitest";

import type { AcceptanceCriterion, CompletionClaim } from "../../contracts";
import { structuredClaimUnmet } from "./structured-claim";

const AC: AcceptanceCriterion[] = [
  { id: "AC-1", text: "Feature X must work" },
  { id: "AC-2", text: "Feature Y must be tested" },
];

describe("structuredClaimUnmet", () => {
  it("returns [] for a fully-evidenced claim", () => {
    const claim: CompletionClaim = {
      criteria: [
        { criterion: "AC-1", evidence: ["test passed"] },
        { criterion: "AC-2", evidence: ["coverage report shows 80%"] },
      ],
    };
    expect(structuredClaimUnmet(AC, claim)).toEqual([]);
  });

  it("emits unmet entry when a criterion has no claim entry (missing)", () => {
    const claim: CompletionClaim = {
      criteria: [{ criterion: "AC-1", evidence: ["test passed"] }],
    };
    const unmet = structuredClaimUnmet(AC, claim);
    expect(unmet).toHaveLength(1);
    expect(unmet[0].criterion).toBe("AC-2");
    expect(unmet[0].reason).toContain("AC-2");
    expect(unmet[0].evidence).toEqual([]);
  });

  it("emits unmet entry when a criterion has an empty evidence array", () => {
    const claim: CompletionClaim = {
      criteria: [
        { criterion: "AC-1", evidence: ["test passed"] },
        { criterion: "AC-2", evidence: [] },
      ],
    };
    const unmet = structuredClaimUnmet(AC, claim);
    expect(unmet).toHaveLength(1);
    expect(unmet[0].criterion).toBe("AC-2");
    expect(unmet[0].evidence).toEqual([]);
    expect(unmet[0].reason).toContain("AC-2");
  });

  it("emits unmet entry when all evidence strings are blank/whitespace", () => {
    const claim: CompletionClaim = {
      criteria: [
        { criterion: "AC-1", evidence: ["test passed"] },
        { criterion: "AC-2", evidence: ["  ", "\t", ""] },
      ],
    };
    const unmet = structuredClaimUnmet(AC, claim);
    expect(unmet).toHaveLength(1);
    expect(unmet[0].criterion).toBe("AC-2");
    expect(unmet[0].evidence).toEqual(["  ", "\t", ""]);
    expect(unmet[0].reason).toContain("AC-2");
  });

  it("emits unmet entries for all failing criteria when none are claimed", () => {
    const claim: CompletionClaim = { criteria: [] };
    const unmet = structuredClaimUnmet(AC, claim);
    expect(unmet).toHaveLength(2);
    expect(unmet.map((u) => u.criterion)).toEqual(["AC-1", "AC-2"]);
  });

  it("returns [] for an empty criteria list regardless of claim content", () => {
    const claim: CompletionClaim = {
      criteria: [{ criterion: "AC-1", evidence: ["something"] }],
    };
    expect(structuredClaimUnmet([], claim)).toEqual([]);
  });

  it("passes a criterion when at least one non-blank evidence string exists", () => {
    const claim: CompletionClaim = {
      criteria: [
        { criterion: "AC-1", evidence: ["  ", "actual evidence"] },
        { criterion: "AC-2", evidence: ["ok"] },
      ],
    };
    expect(structuredClaimUnmet(AC, claim)).toEqual([]);
  });

  it("preserves criterion order from the criteria list in unmet output", () => {
    const orderedAC: AcceptanceCriterion[] = [
      { id: "Z", text: "last" },
      { id: "A", text: "first" },
    ];
    const claim: CompletionClaim = { criteria: [] };
    const unmet = structuredClaimUnmet(orderedAC, claim);
    expect(unmet.map((u) => u.criterion)).toEqual(["Z", "A"]);
  });
});
