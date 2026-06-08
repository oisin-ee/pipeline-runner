import { readFileSync } from "node:fs";
import { z } from "zod";
import { parseJson } from "../safe-json";

export interface PipelineSkillInstallSpec {
  args?: string[];
  source: string;
}

export class PipelineDefaultManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineDefaultManifestError";
  }
}

const DEFAULT_INSTALL_MANIFEST_URL = new URL(
  "../../defaults/install-manifest.json",
  import.meta.url
);

const defaultInstallManifestSchema = z
  .object({
    skills: z
      .array(
        z
          .object({
            args: z.array(z.string()).optional(),
            source: z.string().min(1),
          })
          .strict()
      )
      .default([]),
    version: z.literal(1),
  })
  .strict();

export interface DefaultInstallManifest {
  skills: PipelineSkillInstallSpec[];
  version: 1;
}

function loadDefaultInstallManifest(): DefaultInstallManifest {
  const raw = parseJson(
    readFileSync(DEFAULT_INSTALL_MANIFEST_URL, "utf8"),
    "defaults/install-manifest.json"
  );
  const parsed = defaultInstallManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PipelineDefaultManifestError(
      [
        "Invalid defaults/install-manifest.json.",
        ...parsed.error.issues.map((issue) =>
          [issue.path.join("."), issue.message].filter(Boolean).join(": ")
        ),
      ].join("\n")
    );
  }
  return parsed.data;
}

export const DEFAULT_INSTALL_MANIFEST = loadDefaultInstallManifest();
export const DEFAULT_SKILL_INSTALLS: PipelineSkillInstallSpec[] =
  DEFAULT_INSTALL_MANIFEST.skills;
