const TOML_BARE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

export function tomlValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(tomlValue).join(", ")}]`;
  }
  if (value && typeof value === "object") {
    return `{ ${Object.entries(value)
      .map(([key, item]) => `${tomlKey(key)} = ${tomlValue(item)}`)
      .join(", ")} }`;
  }
  return JSON.stringify(value);
}

function tomlKey(key: string): string {
  return TOML_BARE_KEY_PATTERN.test(key) ? key : JSON.stringify(key);
}
