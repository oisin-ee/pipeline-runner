import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * `.copier-answers.yml` is copier's stamp receipt: `_src_path` records the
 * template a repo was generated from and `_commit` the template version.
 *
 * The org has MULTIPLE copier templates (e.g. the @oisincoveney/dev scaffold
 * also writes `.copier-answers.yml`), so the marker file alone does NOT mean
 * "momokaya-template stamp" — template-update must filter on `_src_path`
 * before fanning a `copier update` PR out to a repo.
 */
const copierAnswersSchema = z
  .object({
    _commit: z.string().optional(),
    _src_path: z.string().optional(),
  })
  .passthrough();

export interface CopierStampReceipt {
  readonly commit?: string;
  readonly srcPath?: string;
}

export function parseCopierAnswers(source: string): CopierStampReceipt {
  const parsed = copierAnswersSchema.parse(parseYaml(source));
  return {
    ...(parsed._commit === undefined ? {} : { commit: parsed._commit }),
    ...(parsed._src_path === undefined ? {} : { srcPath: parsed._src_path }),
  };
}

export function isStampOf(
  receipt: CopierStampReceipt,
  templateMatch: string
): boolean {
  return receipt.srcPath?.includes(templateMatch) ?? false;
}
