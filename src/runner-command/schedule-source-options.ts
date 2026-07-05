import type { z } from "zod";
import { z as zod } from "zod";

export const scheduleSourceFields = {
  scheduleFile: zod.string().min(1).optional(),
  scheduleSource: zod.enum(["db", "file"]).default("file"),
};

export const requireScheduleFileForFileSource = (
  options: { scheduleFile?: string; scheduleSource?: "db" | "file" },
  ctx: z.RefinementCtx
): void => {
  if (
    options.scheduleSource === "file" &&
    (options.scheduleFile === undefined || options.scheduleFile.length === 0)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "scheduleFile is required when scheduleSource is file",
      path: ["scheduleFile"],
    });
  }
};
