import type {
  MokaSubmitInput,
  MokaSubmitOutput,
  ParsedMokaSubmitOptions,
} from "./remote/submit/contract";
import {
  mokaSubmitDirectHooksSchema as contractDirectHooksSchema,
  mokaSubmitHookPolicySchema as contractHookPolicySchema,
  mokaSubmitOptionsSchema as contractOptionsSchema,
  mokaSubmitResultSchema as contractResultSchema,
} from "./remote/submit/contract";
import { configWithSubmitHooks } from "./remote/submit/event-boundary";
import {
  type SubmitMokaDependencies,
  submitParsedMoka,
} from "./remote/submit/service";

export type {
  MokaSubmitDirectHooksInput,
  MokaSubmitDirectHooksOutput,
  MokaSubmitHookPolicyInput,
  MokaSubmitHookPolicyOutput,
  MokaSubmitInput,
  MokaSubmitOptions,
  MokaSubmitOptionsInput,
  MokaSubmitOptionsOutput,
  MokaSubmitOutput,
  MokaSubmitResult,
} from "./remote/submit/contract";

export const mokaSubmitDirectHooksSchema = contractDirectHooksSchema;
export const mokaSubmitHookPolicySchema = contractHookPolicySchema;
export const mokaSubmitOptionsSchema = contractOptionsSchema;
export const mokaSubmitResultSchema = contractResultSchema;

export function submitMoka(
  rawOptions: MokaSubmitInput,
  dependencies: SubmitMokaDependencies = {}
): Promise<MokaSubmitOutput> {
  const { config, worktreePath, ...schemaOptions } = rawOptions;
  const options = mokaSubmitOptionsSchema.parse(schemaOptions);
  const parsedOptions: ParsedMokaSubmitOptions = {
    ...options,
    config: configWithSubmitHooks(config, options.hooks),
    worktreePath,
  };
  return submitParsedMoka(parsedOptions, dependencies);
}
