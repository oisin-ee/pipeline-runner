import { Buffer } from "node:buffer";

export const literalArgFlagName = "moka-literal-arg";

export const encodeLiteralCliArg = (value: string): string =>
  Buffer.from(value, "utf-8").toString("base64url");

export const decodeLiteralCliArgs = (values: readonly string[]): string[] =>
  values.map((value) => Buffer.from(value, "base64url").toString("utf-8"));

const hasValue = (argv: readonly string[], index: number): boolean => {
  const next = argv[index + 1];
  return next !== undefined && next !== "--" && !next.startsWith("-");
};

const valueOptionalFlagName = (arg: string): string | undefined => {
  if (!arg.startsWith("--") || arg === "--" || arg.includes("=")) {
    return undefined;
  }
  const name = arg.slice(2);
  return name.length > 0 ? name : undefined;
};

export const expandValueOptionalFlags = (
  argv: readonly string[],
  names: ReadonlySet<string>
): string[] =>
  argv.flatMap((arg, index) => {
    const name = valueOptionalFlagName(arg);
    if (name === undefined || !names.has(name) || hasValue(argv, index)) {
      return [arg];
    }
    return [`${arg}=true`];
  });
