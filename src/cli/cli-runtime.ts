import { NodeServices } from "@effect/platform-node";
import { Layer } from "effect";
import { CliOutput } from "effect/unstable/cli";

const defaultFormatter = CliOutput.defaultFormatter({ colors: false });

const mokaCliFormatter: CliOutput.Formatter = {
  formatCliError: defaultFormatter.formatCliError,
  formatError: defaultFormatter.formatError,
  formatErrors: defaultFormatter.formatErrors,
  formatHelpDoc: defaultFormatter.formatHelpDoc,
  formatVersion: (_name, version) => version,
};

export const mokaCliRuntimeLayer = Layer.mergeAll(
  CliOutput.layer(mokaCliFormatter),
  NodeServices.layer
);
