import * as Arr from "effect/Array";
import * as Option from "effect/Option";

import type { PipelineRuntimeEvent } from "./pipeline-runtime";

export type RuntimeEventType = PipelineRuntimeEvent["type"];
export type RuntimeEventOf<Type extends RuntimeEventType> = Extract<
  PipelineRuntimeEvent,
  { type: Type }
>;

export interface RuntimeEventMapping<Context, Output> {
  readonly handle: (
    event: PipelineRuntimeEvent,
    context: Context
  ) => Option.Option<Output>;
  readonly type: RuntimeEventType;
}

const isRuntimeEventOfType = <Type extends RuntimeEventType>(
  event: PipelineRuntimeEvent,
  type: Type
): event is RuntimeEventOf<Type> => event.type === type;

export const runtimeEventMapping = <
  Type extends RuntimeEventType,
  Context,
  Output,
>(
  type: Type,
  map: (event: RuntimeEventOf<Type>, context: Context) => Output
): RuntimeEventMapping<Context, Output> => ({
  handle: (event, context) =>
    isRuntimeEventOfType(event, type)
      ? Option.some(map(event, context))
      : Option.none(),
  type,
});

export const firstRuntimeEventMapping = <Context, Output>(
  event: PipelineRuntimeEvent,
  context: Context,
  mappings: readonly RuntimeEventMapping<Context, Output>[]
): Option.Option<Output> =>
  Option.firstSomeOf(
    Arr.map((mapping: RuntimeEventMapping<Context, Output>) =>
      mapping.handle(event, context)
    )(mappings)
  );
