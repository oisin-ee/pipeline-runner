import { Option } from "effect";

import type { HookEvent, PipelineConfig } from "../../config";
import type {
  MokaSubmitDirectHook,
  MokaSubmitDirectHooks,
  ParsedMokaBaseOptions,
} from "../../moka-submit";
import type { RunnerCommandPayload } from "../../runner-command-contract";
import { MOKA_SUBMIT_HOOK_EVENTS } from "./hook-events";

type HookFunctionConfig = PipelineConfig["hooks"]["functions"][string];
type CommandHookFunctionConfig = Extract<
  HookFunctionConfig,
  { kind: "command" }
>;
type ModuleHookFunctionConfig = Extract<HookFunctionConfig, { kind: "module" }>;
type HookBindingConfig = PipelineConfig["hooks"]["on"][string][number];

const submitHookId = (event: HookEvent) =>
  `moka-submit-${event.replaceAll(".", "-")}`;

const moduleHookFunctionForSubmitHook = (
  hook: Extract<MokaSubmitDirectHook, { kind: "module" }>
): ModuleHookFunctionConfig => {
  const hookFunction: ModuleHookFunctionConfig = {
    kind: "module",
    module: hook.module,
  };
  if (hook.timeoutMs !== undefined) {
    hookFunction.timeout_ms = hook.timeoutMs;
  }
  return hookFunction;
};

const commandHookFunctionForSubmitHook = (
  hook: Extract<MokaSubmitDirectHook, { kind: "command" }>
): CommandHookFunctionConfig => {
  const hookFunction: CommandHookFunctionConfig = {
    command: hook.command,
    kind: "command",
    protocol: { input: "file", result: "file" },
  };
  if (hook.outputLimitBytes !== undefined) {
    hookFunction.output_limit_bytes = hook.outputLimitBytes;
  }
  if (hook.timeoutMs !== undefined) {
    hookFunction.timeout_ms = hook.timeoutMs;
  }
  if (hook.trusted !== undefined) {
    hookFunction.trusted = hook.trusted;
  }
  return hookFunction;
};

const hookFunctionForSubmitHook = (
  hook: MokaSubmitDirectHook
): HookFunctionConfig =>
  hook.kind === "module"
    ? moduleHookFunctionForSubmitHook(hook)
    : commandHookFunctionForSubmitHook(hook);

const submitHookHasResult = (hook: MokaSubmitDirectHook): boolean =>
  hook.publishResult !== undefined || hook.saveResultAs !== undefined;

const addSubmitHookResultFields = (
  result: NonNullable<HookBindingConfig["result"]>,
  hook: MokaSubmitDirectHook
): void => {
  if (hook.publishResult !== undefined) {
    result.publish = hook.publishResult;
  }
  if (hook.saveResultAs !== undefined) {
    result.save_as = hook.saveResultAs;
  }
};

const submitHookBindingResult = (
  hook: MokaSubmitDirectHook
): Option.Option<NonNullable<HookBindingConfig["result"]>> => {
  if (!submitHookHasResult(hook)) {
    return Option.none();
  }

  const result: NonNullable<HookBindingConfig["result"]> = {};
  addSubmitHookResultFields(result, hook);
  return Option.some(result);
};

const hookBindingForSubmitHook = (
  event: HookEvent,
  hook: MokaSubmitDirectHook
): HookBindingConfig => {
  const id = submitHookId(event);
  const binding: HookBindingConfig = {
    failure: hook.failure,
    function: id,
    id,
  };

  const result = submitHookBindingResult(hook);
  if (Option.isSome(result)) {
    binding.result = result.value;
  }
  if (hook.where !== undefined) {
    binding.where = hook.where;
  }
  if (hook.input !== undefined) {
    binding.with = hook.input;
  }
  return binding;
};

const submitHookEntries = (
  hooks: Option.Option<MokaSubmitDirectHooks>
): {
  event: HookEvent;
  hook: MokaSubmitDirectHook;
}[] => {
  const entries: { event: HookEvent; hook: MokaSubmitDirectHook }[] = [];
  for (const event of MOKA_SUBMIT_HOOK_EVENTS) {
    const hook = Option.isSome(hooks) ? hooks.value[event] : undefined;
    if (hook !== undefined) {
      entries.push({ event, hook });
    }
  }
  return entries;
};

const cloneHookBindings = (
  on: PipelineConfig["hooks"]["on"]
): PipelineConfig["hooks"]["on"] => {
  const cloned: PipelineConfig["hooks"]["on"] = {};
  for (const [event, bindings] of Object.entries(on)) {
    cloned[event] = [...bindings];
  }
  return cloned;
};

const appendSubmitHook = (
  event: HookEvent,
  hook: MokaSubmitDirectHook,
  target: Pick<PipelineConfig["hooks"], "functions" | "on">
): void => {
  const id = submitHookId(event);
  if (Object.hasOwn(target.functions, id)) {
    throw new Error(`Moka submit hook id already exists in config: ${id}`);
  }
  target.functions[id] = hookFunctionForSubmitHook(hook);
  target.on[event] = [
    ...(target.on[event] ?? []),
    hookBindingForSubmitHook(event, hook),
  ];
};

export const configWithSubmitHooks = (
  config: PipelineConfig,
  hooks?: MokaSubmitDirectHooks
): PipelineConfig => {
  const entries = submitHookEntries(Option.fromUndefinedOr(hooks));
  if (entries.length === 0) {
    return config;
  }

  const target = {
    functions: { ...config.hooks.functions },
    on: cloneHookBindings(config.hooks.on),
  };

  for (const { event, hook } of entries) {
    appendSubmitHook(event, hook, target);
  }

  return {
    ...config,
    hooks: {
      ...config.hooks,
      functions: target.functions,
      on: target.on,
    },
  };
};

const eventAuthTokenFile = (options: ParsedMokaBaseOptions): string => {
  if (
    options.eventAuthSecretKey === undefined ||
    options.eventAuthSecretKey.length === 0
  ) {
    throw new Error(
      "eventAuthSecretKey is required unless eventSink.authTokenFile is provided"
    );
  }
  return `/etc/pipeline/event-auth/${options.eventAuthSecretKey}`;
};

const runnerEventsFromSink = (
  options: ParsedMokaBaseOptions,
  eventSink: NonNullable<ParsedMokaBaseOptions["eventSink"]>
): RunnerCommandPayload["events"] => ({
  authHeader: eventSink.authHeader,
  authTokenFile: eventSink.authTokenFile ?? eventAuthTokenFile(options),
  url: eventSink.url,
});

const runnerEventsFromUrl = (
  options: ParsedMokaBaseOptions
): RunnerCommandPayload["events"] => {
  if (options.eventUrl === undefined || options.eventUrl.length === 0) {
    throw new Error(
      "eventUrl is required unless eventSink or events is provided"
    );
  }
  return {
    authHeader: "Authorization",
    authTokenFile: eventAuthTokenFile(options),
    url: options.eventUrl,
  };
};

export const runnerEvents = (
  options: ParsedMokaBaseOptions
): RunnerCommandPayload["events"] => {
  const eventSink = options.eventSink ?? options.events;
  return eventSink === undefined
    ? runnerEventsFromUrl(options)
    : runnerEventsFromSink(options, eventSink);
};
