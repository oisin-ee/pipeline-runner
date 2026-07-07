import * as Option from "effect/Option";

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
interface SubmitHookTarget {
  functions: Record<string, HookFunctionConfig>;
  on: Record<string, HookBindingConfig[]>;
}

const submitHookId = (event: HookEvent) =>
  `moka-submit-${event.replaceAll(".", "-")}`;

const moduleHookFunctionForSubmitHook = (
  hook: Extract<MokaSubmitDirectHook, { kind: "module" }>
): ModuleHookFunctionConfig => ({
  kind: "module",
  module: hook.module,
  ...(hook.timeoutMs === undefined ? {} : { timeout_ms: hook.timeoutMs }),
});

const commandHookFunctionForSubmitHook = (
  hook: Extract<MokaSubmitDirectHook, { kind: "command" }>
): CommandHookFunctionConfig => ({
  command: hook.command,
  kind: "command",
  ...(hook.outputLimitBytes === undefined
    ? {}
    : { output_limit_bytes: hook.outputLimitBytes }),
  protocol: { input: "file", result: "file" },
  ...(hook.timeoutMs === undefined ? {} : { timeout_ms: hook.timeoutMs }),
  ...(hook.trusted === undefined ? {} : { trusted: hook.trusted }),
});

const hookFunctionForSubmitHook = (
  hook: MokaSubmitDirectHook
): HookFunctionConfig =>
  hook.kind === "module"
    ? moduleHookFunctionForSubmitHook(hook)
    : commandHookFunctionForSubmitHook(hook);

const submitHookHasResult = (hook: MokaSubmitDirectHook): boolean =>
  hook.publishResult !== undefined || hook.saveResultAs !== undefined;

const addSubmitHookResultFields = (
  hook: MokaSubmitDirectHook
): NonNullable<HookBindingConfig["result"]> => ({
  ...(hook.publishResult === undefined ? {} : { publish: hook.publishResult }),
  ...(hook.saveResultAs === undefined ? {} : { save_as: hook.saveResultAs }),
});

const submitHookBindingResult = (
  hook: MokaSubmitDirectHook
): Option.Option<NonNullable<HookBindingConfig["result"]>> => {
  if (!submitHookHasResult(hook)) {
    return Option.none();
  }

  return Option.some(addSubmitHookResultFields(hook));
};

const hookBindingForSubmitHook = (
  event: HookEvent,
  hook: MokaSubmitDirectHook
): HookBindingConfig => {
  const id = submitHookId(event);
  const result = submitHookBindingResult(hook);
  return {
    failure: hook.failure,
    function: id,
    id,
    ...(Option.isSome(result) ? { result: result.value } : {}),
    ...(hook.where === undefined ? {} : { where: hook.where }),
    ...(hook.input === undefined ? {} : { with: hook.input }),
  };
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
): Record<string, HookBindingConfig[]> => {
  const cloned: Record<string, HookBindingConfig[]> = {};
  for (const [event, bindings] of Object.entries(on)) {
    cloned[event] = [...bindings];
  }
  return cloned;
};

const appendSubmitHook = (
  event: HookEvent,
  hook: MokaSubmitDirectHook,
  target: SubmitHookTarget
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
