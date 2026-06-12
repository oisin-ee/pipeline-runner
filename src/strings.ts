export interface UniqueStringsOptions {
  filterEmpty?: boolean;
  sort?: boolean;
}

export function uniqueStrings(
  values: string[],
  options: UniqueStringsOptions = {}
): string[] {
  const input = options.filterEmpty ? values.filter(Boolean) : values;
  const unique = [...new Set(input)];
  return options.sort ? unique.sort() : unique;
}
