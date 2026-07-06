import * as Schema from "effect/Schema";

import { requiredString, withDefault } from "../schema-boundary";

export const scheduleSourceFields = {
  scheduleFile: Schema.optional(requiredString),
  scheduleSource: withDefault(Schema.Literals(["db", "file"]), "file"),
};

export const requireScheduleFileForFileSource = (options: {
  scheduleFile?: string;
  scheduleSource?: "db" | "file";
}): true | { issue: string; path: readonly PropertyKey[] } =>
  options.scheduleSource === "file" && (options.scheduleFile === undefined || options.scheduleFile.length === 0)
    ? {
        issue: "scheduleFile is required when scheduleSource is file",
        path: ["scheduleFile"],
      }
    : true;
