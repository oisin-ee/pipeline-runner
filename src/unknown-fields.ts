import * as Option from "effect/Option";
import * as P from "effect/Predicate";

const isUnknownRecord = (value: unknown): value is Record<string, unknown> =>
  P.isObject(value) && !Array.isArray(value);

export const stringField = (value: unknown, field: string): Option.Option<string> => {
  if (!isUnknownRecord(value)) {
    return Option.none();
  }
  const fieldValue = value[field];
  return P.isString(fieldValue) ? Option.some(fieldValue) : Option.none();
};

export const numberField = (value: unknown, field: string): Option.Option<number> => {
  if (!isUnknownRecord(value)) {
    return Option.none();
  }
  const fieldValue = value[field];
  return P.isNumber(fieldValue) ? Option.some(fieldValue) : Option.none();
};

export const booleanField = (value: unknown, field: string): Option.Option<boolean> => {
  if (!isUnknownRecord(value)) {
    return Option.none();
  }
  const fieldValue = value[field];
  return P.isBoolean(fieldValue) ? Option.some(fieldValue) : Option.none();
};
