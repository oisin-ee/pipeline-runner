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

function hookFunctionForSubmitHook(
  hook: MokaSubmitDirectHook
): HookFunctionConfig {
  return hook.kind === "module"
    ? moduleHookFunctionForSubmitHook(hook)
    : commandHookFunctionForSubmitHook(hook);
}

function moduleHookFunctionForSubmitHook(
  hook: Extract<MokaSubmitDirectHook, { kind: "module" }>
): ModuleHookFunctionConfig {
  const hookFunction: ModuleHookFunctionConfig = {
    kind: "module",
    module: hook.module,
  };
  if (hook.timeoutMs !== undefined) {
    hookFunction.timeout_ms = hook.timeoutMs;
  }
  return hookFunction;
}

function commandHookFunctionForSubmitHook(
  hook: Extract<MokaSubmitDirectHook, { kind: "command" }>
): CommandHookFunctionConfig {
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
}

function submitHookBindingResult(
  hook: MokaSubmitDirectHook
): HookBindingConfig["result"] {
  if (!submitHookHasResult(hook)) {
    return;
  }

  const result: NonNullable<HookBindingConfig["result"]> = {};
  addSubmitHookResultFields(result, hook);
  return result;
}

function submitHookHasResult(hook: MokaSubmitDirectHook): boolean {
  return hook.publishResult !== undefined || hook.saveResultAs !== undefined;
}

function addSubmitHookResultFields(
  result: NonNullable<HookBindingConfig["result"]>,
  hook: MokaSubmitDirectHook
): void {
  if (hook.publishResult !== undefined) {
    result.publish = hook.publishResult;
  }
  if (hook.saveResultAs !== undefined) {
    result.save_as = hook.saveResultAs;
  }
}

function hookBindingForSubmitHook(
  event: HookEvent,
  hook: MokaSubmitDirectHook
): HookBindingConfig {
  const id = submitHookId(event);
  const binding: HookBindingConfig = {
    failure: hook.failure,
    function: id,
    id,
  };

  const result = submitHookBindingResult(hook);
  if (result !== undefined) {
    binding.result = result;
  }
  if (hook.where !== undefined) {
    binding.where = hook.where;
  }
  if (hook.input !== undefined) {
    binding.with = hook.input;
  }
  return binding;
}

function submitHookEntries(hooks: MokaSubmitDirectHooks | undefined): Array<{
  event: HookEvent;
  hook: MokaSubmitDirectHook;
}> {
  const entries: Array<{ event: HookEvent; hook: MokaSubmitDirectHook }> = [];
  for (const event of MOKA_SUBMIT_HOOK_EVENTS) {
    const hook = hooks?.[event];
    if (hook !== undefined) {
      entries.push({ event, hook });
    }
  }
  return entries;
}

function cloneHookBindings(
  on: PipelineConfig["hooks"]["on"]
): PipelineConfig["hooks"]["on"] {
  const cloned: PipelineConfig["hooks"]["on"] = {};
  for (const [event, bindings] of Object.entries(on)) {
    cloned[event] = [...bindings];
  }
  return cloned;
}

function appendSubmitHook(
  event: HookEvent,
  hook: MokaSubmitDirectHook,
  target: Pick<PipelineConfig["hooks"], "functions" | "on">
): void {
  const id = submitHookId(event);
  if (target.functions[id] !== undefined) {
    throw new Error(`Moka submit hook id already exists in config: ${id}`);
  }
  target.functions[id] = hookFunctionForSubmitHook(hook);
  target.on[event] = [
    ...(target.on[event] ?? []),
    hookBindingForSubmitHook(event, hook),
  ];
}

export function configWithSubmitHooks(
  config: PipelineConfig,
  hooks: MokaSubmitDirectHooks | undefined
): PipelineConfig {
  const entries = submitHookEntries(hooks);
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
}

export function runnerEvents(
  options: ParsedMokaBaseOptions
): RunnerCommandPayload["events"] {
  const eventSink = options.eventSink ?? options.events;
  return eventSink
    ? runnerEventsFromSink(options, eventSink)
    : runnerEventsFromUrl(options);
}

function runnerEventsFromSink(
  options: ParsedMokaBaseOptions,
  eventSink: NonNullable<ParsedMokaBaseOptions["eventSink"]>
): RunnerCommandPayload["events"] {
  return {
    authHeader: eventSink.authHeader,
    authTokenFile: eventSink.authTokenFile ?? eventAuthTokenFile(options),
    url: eventSink.url,
  };
}

function runnerEventsFromUrl(
  options: ParsedMokaBaseOptions
): RunnerCommandPayload["events"] {
  if (!options.eventUrl) {
    throw new Error(
      "eventUrl is required unless eventSink or events is provided"
    );
  }
  return {
    authHeader: "Authorization",
    authTokenFile: eventAuthTokenFile(options),
    url: options.eventUrl,
  };
}

function eventAuthTokenFile(options: ParsedMokaBaseOptions): string {
  if (!options.eventAuthSecretKey) {
    throw new Error(
      "eventAuthSecretKey is required unless eventSink.authTokenFile is provided"
    );
  }
  return `/etc/pipeline/event-auth/${options.eventAuthSecretKey}`;
}
