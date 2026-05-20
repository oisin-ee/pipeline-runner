import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GateViolation } from "../gates.js";

interface LearnOptions {
  outcome: "PASS" | "FAIL";
  taskDescription: string;
  testOutput: string;
  violations: GateViolation[];
  worktreePath: string;
}

export async function runLearn(opts: LearnOptions): Promise<void> {
  const { worktreePath, taskDescription, outcome, violations, testOutput } =
    opts;

  const knowledgeDir = join(worktreePath, ".pipeline", "knowledge");
  await mkdir(knowledgeDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${timestamp}.md`;

  const violationSection =
    violations.length > 0
      ? `\n## Violations\n${violations.map((v) => `- ${v.file}: ${v.message}`).join("\n")}`
      : "";

  const truncatedOutput = testOutput.slice(0, 2000);

  const content = `# Task: ${taskDescription}

## Outcome: ${outcome}
${violationSection}

## Test Output
\`\`\`
${truncatedOutput}
\`\`\`
`;

  await writeFile(join(knowledgeDir, filename), content);
}
