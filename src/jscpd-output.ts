import {
  isNumberValue,
  isRecord,
  isStringValue,
  parseJsonResult,
} from "./safe-json";

export interface JscpdDuplicateViolation {
  file: string;
  line?: number;
  message: string;
}

interface JscpdFileLocation {
  line?: number;
  name: string;
}

const jscpdFileLocation = (file: unknown): JscpdFileLocation => {
  if (!isRecord(file)) {
    return { name: "unknown" };
  }
  const name = isStringValue(file.name) ? file.name : "unknown";
  return isNumberValue(file.start) ? { line: file.start, name } : { name };
};

const jscpdDuplicateFile = (
  duplicate: unknown,
  key: "firstFile" | "secondFile"
): unknown => (isRecord(duplicate) ? duplicate[key] : undefined);

const jscpdDuplicateViolation = (
  duplicate: unknown
): JscpdDuplicateViolation => {
  const firstFile = jscpdDuplicateFile(duplicate, "firstFile");
  const secondFile = jscpdDuplicateFile(duplicate, "secondFile");
  const firstLocation = jscpdFileLocation(firstFile);
  const secondLocation = jscpdFileLocation(secondFile);
  return {
    file: firstLocation.name,
    line: firstLocation.line,
    message: `Duplicate code block detected between ${firstLocation.name} and ${secondLocation.name}`,
  };
};

export const parseJscpdDuplicateViolations = (
  output: string
): JscpdDuplicateViolation[] => {
  const parsed = parseJsonResult(output, "jscpd output");
  const duplicates =
    isRecord(parsed.value) && Array.isArray(parsed.value.duplicates)
      ? parsed.value.duplicates
      : [];
  return duplicates.map(jscpdDuplicateViolation);
};
