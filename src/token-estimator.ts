import { getEncoding, type Tiktoken } from "js-tiktoken";

/**
 * Token estimation for node sizing. Uses the `o200k_base` BPE as a
 * model-agnostic heuristic — NOT a guarantee of any specific model's tokenizer.
 *
 * This is a cross-model ESTIMATE, not a billing-accurate count: the pipeline
 * routes nodes across OpenAI/Kimi/Qwen models whose exact tokenizers differ (and
 * are not all known here), so treat the value as a sizing heuristic for
 * budget/routing decisions only. For exact counts on Anthropic runners, use the
 * Anthropic `count_tokens` API.
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
