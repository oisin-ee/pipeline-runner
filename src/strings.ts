export interface UniqueStringsOptions {
  filterEmpty?: boolean;
  sort?: boolean;
}

export const uniqueStrings = (
  values: string[],
  options: UniqueStringsOptions = {}
): string[] => {
  const input =
    options.filterEmpty === true
      ? values.filter((value) => value.length > 0)
      : values;
  const unique = [...new Set(input)];
  return options.sort === true ? unique.toSorted() : unique;
};

const GENERATED_ID_INVALID_CHARS_RE = /[^a-z0-9]+/gu;
const GENERATED_ID_TRIM_HYPHENS_RE = /^-+|-+$/gu;
const STARTS_WITH_ALPHA_RE = /^[a-z]/u;

/**
 * Slugify an arbitrary string into a workflow-safe id (lowercase, hyphenated).
 * When the slug does not begin with a letter it is prefixed with
 * `fallbackPrefix` so the result is always a valid node/workflow id.
 */
const generatedId = (value: string, fallbackPrefix: string): string => {
  const slug = value
    .trim()
    .toLowerCase()
    .replaceAll(GENERATED_ID_INVALID_CHARS_RE, "-")
    .replaceAll(GENERATED_ID_TRIM_HYPHENS_RE, "");
  if (STARTS_WITH_ALPHA_RE.test(slug)) {
    return slug;
  }
  return slug.length > 0 ? `${fallbackPrefix}-${slug}` : fallbackPrefix;
};

/**
 * Slugify `value` to a generated id (see {@link generatedId}) and disambiguate
 * against `usedIds` by appending an incrementing numeric suffix. Mutates
 * `usedIds` to reserve the chosen id.
 */
export const uniqueGeneratedId = (
  value: string,
  usedIds: Set<string>,
  fallbackPrefix: string
): string => {
  const base = generatedId(value, fallbackPrefix);
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
};
