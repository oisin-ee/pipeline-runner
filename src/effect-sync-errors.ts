import type { Cause } from "effect/Cause";
import { findError, squash } from "effect/Cause";
import { isSuccess } from "effect/Result";

import { isStringValue, isUnknownRecord } from "./schema-boundary";

export const unknownErrorMessage = (error: unknown): string => {
  if (isUnknownRecord(error) && "message" in error) {
    const { message } = error;
    if (isStringValue(message)) {
      return message;
    }
  }
  return String(error);
};

const causeFailure = <E>(cause: Cause<E>): unknown => {
  const failure = findError(cause);
  return isSuccess(failure) ? failure.success : squash(cause);
};

const causeFailureAsError = <E>(cause: Cause<E>): Error =>
  new TypeError(unknownErrorMessage(causeFailure(cause)));

export const throwCauseFailure = <E>(cause: Cause<E>): never => {
  throw causeFailure(cause);
};

export const throwCauseFailureAsError = <E>(cause: Cause<E>): never => {
  throw causeFailureAsError(cause);
};
