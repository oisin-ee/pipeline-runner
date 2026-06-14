import { getEncoding, type Tiktoken } from "js-tiktoken";

/**
 * Token estimation for node sizing. Uses the `o200k_base` encoding (the GPT-5.5
 * family the MoKa agents run on).
 *
 * This is a cross-model ESTIMATE, not a billing-accurate count: the pipeline
 * routes nodes across OpenAI/Kimi/Qwen models whose tokenizers differ, so the
 * value is a sizing heuristic for budget/routing decisions. For exact counts on
 * Anthropic runners, use the Anthropic `count_tokens` API instead.
 */
let encoder: Tiktoken | undefined;

function encoding(): Tiktoken {
  encoder ??= getEncoding("o200k_base");
  return encoder;
}

export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return encoding().encode(text).length;
}
