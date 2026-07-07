import { describe, expect, it, vi } from "vitest";

import type {
  AcceptanceCriterion,
  CompletionClaim,
  CriterionEvidence,
  UnmetCriterion,
} from "../../contracts";
import type { LlmJudge, LlmJudgeVerdict } from "./llm-judge";
import { llmJudgeUnmet } from "./llm-judge";

const CRITERION: AcceptanceCriterion = {
  id: "A",
  text: "residual criterion only the judge can settle",
};
const DETERMINISTIC = ["deterministic: tests pass"];

const claimFor = (...criteria: CriterionEvidence[]): CompletionClaim => ({
  criteria,
});

const verdict = (overrides: Partial<LlmJudgeVerdict>): LlmJudgeVerdict => ({
  citedEvidence: [],
  rationale: "stub",
  satisfied: false,
  ...overrides,
});

/** Adjudicate the single shared {@link CRITERION} against one claimed-evidence set. */
const judgeResidue = (
  judge: LlmJudge,
  claimedEvidence: string[],
  deterministic: string[] = DETERMINISTIC
): UnmetCriterion[] =>
  llmJudgeUnmet(
    [CRITERION],
    claimFor({ criterion: "A", evidence: claimedEvidence }),
    deterministic,
    judge
  );

describe("llmJudgeUnmet anti-gaming (trivial input refused without judge)", () => {
  it("refuses a criterion with no claimed evidence WITHOUT invoking the judge", () => {
    const judge = vi.fn<LlmJudge>(() => verdict({ satisfied: true }));
    const unmet = judgeResidue(judge, []);
    expect(judge).not.toHaveBeenCalled();
    expect(unmet).toHaveLength(1);
    expect(unmet[0]?.criterion).toBe("A");
    expect(unmet[0]?.reason).toContain("without consulting");
  });

  it("refuses a criterion whose claimed evidence is all blank WITHOUT invoking the judge", () => {
    const judge = vi.fn<LlmJudge>(() => verdict({ satisfied: true }));
    const unmet = judgeResidue(judge, ["   ", "\t", ""]);
    expect(judge).not.toHaveBeenCalled();
    expect(unmet).toHaveLength(1);
    expect(unmet[0]?.evidence).toEqual(["   ", "\t", ""]);
  });

  it("refuses a residue criterion absent from the claim WITHOUT invoking the judge", () => {
    const judge = vi.fn<LlmJudge>(() => verdict({ satisfied: true }));
    const unmet = llmJudgeUnmet(
      [CRITERION],
      claimFor({ criterion: "OTHER", evidence: ["irrelevant"] }),
      DETERMINISTIC,
      judge
    );
    expect(judge).not.toHaveBeenCalled();
    expect(unmet).toHaveLength(1);
  });
});

describe("llmJudgeUnmet anchoring (verdict must cite real deterministic evidence)", () => {
  const claimed = ["agent says it works"];

  it("rejects a satisfied verdict that cites NO evidence", () => {
    const judge: LlmJudge = () =>
      verdict({ citedEvidence: [], satisfied: true });
    const unmet = judgeResidue(judge, claimed);
    expect(unmet).toHaveLength(1);
    expect(unmet[0]?.reason).toContain("cited no deterministic evidence");
  });

  it("rejects a satisfied verdict that cites FOREIGN evidence not in the deterministic set", () => {
    const judge: LlmJudge = () =>
      verdict({ citedEvidence: ["invented anchor"], satisfied: true });
    const unmet = judgeResidue(judge, claimed);
    expect(unmet).toHaveLength(1);
    expect(unmet[0]?.reason).toContain("not present in the deterministic");
    expect(unmet[0]?.evidence).toEqual(["invented anchor"]);
  });

  it("rejects a satisfied verdict where only SOME cited evidence is anchored", () => {
    const judge: LlmJudge = () =>
      verdict({
        citedEvidence: ["deterministic: tests pass", "invented anchor"],
        satisfied: true,
      });
    const unmet = judgeResidue(judge, claimed);
    expect(unmet).toHaveLength(1);
    expect(unmet[0]?.reason).toContain("not present in the deterministic");
  });

  it("honors a satisfied verdict whose cited evidence is fully anchored", () => {
    const judge: LlmJudge = () =>
      verdict({
        citedEvidence: ["deterministic: tests pass"],
        satisfied: true,
      });
    expect(judgeResidue(judge, claimed)).toEqual([]);
  });
});

describe("llmJudgeUnmet judge verdict", () => {
  it("returns an unmet entry when the judge marks the criterion unsatisfied", () => {
    const judge: LlmJudge = () =>
      verdict({
        citedEvidence: ["deterministic: tests pass"],
        satisfied: false,
      });
    const unmet = judgeResidue(judge, ["agent says it works"]);
    expect(unmet).toHaveLength(1);
    expect(unmet[0]?.reason).toContain(
      "marked the residual criterion unsatisfied"
    );
  });

  it("passes the meaningful (non-blank) claimed evidence to the judge", () => {
    const judge = vi.fn<LlmJudge>(() =>
      verdict({ citedEvidence: ["deterministic: tests pass"], satisfied: true })
    );
    judgeResidue(judge, ["  ", "real evidence", ""]);
    expect(judge).toHaveBeenCalledWith({
      claimedEvidence: ["real evidence"],
      criterion: CRITERION,
      deterministicEvidence: DETERMINISTIC,
    });
  });
});

describe("llmJudgeUnmet residue handling", () => {
  it("judges only the supplied residue and reports one entry per failing criterion", () => {
    const honored: AcceptanceCriterion = { id: "A", text: "anchored pass" };
    const refused: AcceptanceCriterion = { id: "B", text: "no anchor" };
    const judge: LlmJudge = (input) =>
      input.criterion.id === "A"
        ? verdict({ citedEvidence: ["det: build green"], satisfied: true })
        : verdict({ citedEvidence: [], satisfied: true });
    const unmet = llmJudgeUnmet(
      [honored, refused],
      claimFor(
        { criterion: "A", evidence: ["a works"] },
        { criterion: "B", evidence: ["b works"] }
      ),
      ["det: build green"],
      judge
    );
    expect(unmet.map((entry) => entry.criterion)).toEqual(["B"]);
  });

  it("returns an empty list when there is no residue to judge", () => {
    const judge = vi.fn<LlmJudge>(() => verdict({ satisfied: true }));
    expect(llmJudgeUnmet([], claimFor(), ["det"], judge)).toEqual([]);
    expect(judge).not.toHaveBeenCalled();
  });
});
