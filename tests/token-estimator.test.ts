import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/token-estimator";

describe("estimateTokens", () => {
  it("returns 0 for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns strictly more tokens for longer text", () => {
    const short = estimateTokens("hello world");
    const long = estimateTokens("hello world ".repeat(50));
    expect(long).toBeGreaterThan(short);
  });

  it("estimates a known string within a sane band", () => {
    // "The quick brown fox jumps over the lazy dog" tokenizes to ~9-10 tokens.
    const count = estimateTokens("The quick brown fox jumps over the lazy dog");
    expect(count).toBeGreaterThanOrEqual(8);
    expect(count).toBeLessThanOrEqual(12);
  });
});
