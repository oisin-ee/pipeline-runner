import * as Schema from "effect/Schema";
import { parse as parseYaml } from "yaml";

import { parseWithSchema, struct } from "../schema-boundary";

/**
 * `.copier-answers.yml` is copier's stamp receipt: `_src_path` records the
 * template a repo was generated from and `_commit` the template version.
 *
 * The org has MULTIPLE copier templates (e.g. the @oisincoveney/dev scaffold
 * also writes `.copier-answers.yml`), so the marker file alone does NOT mean
 * "momokaya-template stamp" — template-update must filter on `_src_path`
 * before fanning a `copier update` PR out to a repo.
 */
const copierAnswers = Schema.StructWithRest(
  struct({
    _commit: Schema.optional(Schema.String),
    _src_path: Schema.optional(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);

export interface CopierStampReceipt {
  readonly commit?: string;
  readonly srcPath?: string;
}

export const parseCopierAnswers = (source: string): CopierStampReceipt => {
  const parsed = parseWithSchema(copierAnswers, parseYaml(source), {
    onExcessProperty: "preserve",
  });
  return {
    ...(parsed._commit === undefined ? {} : { commit: parsed._commit }),
    ...(parsed._src_path === undefined ? {} : { srcPath: parsed._src_path }),
  };
};

export const isStampOf = (
  receipt: CopierStampReceipt,
  templateMatch: string
): boolean => receipt.srcPath?.includes(templateMatch) ?? false;
