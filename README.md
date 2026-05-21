# oisin-pipeline

Mastra-based pipeline for coordinating repository work through research, red,
green, verification, and learning phases.

## Requirements

- Bun 1.1 or newer
- Node.js 22.13 or newer

Install dependencies with:

```shell
bun install --frozen-lockfile
```

## Development

Start Mastra Studio locally:

```shell
bun run dev
```

Open <http://localhost:4111> to inspect and run the Mastra application.

## Workflow output

CLI consumers can rely on the workflow result retaining an `outcome` field:

```ts
{
  outcome: "PASS" | "FAIL";
  failureDetails: Array<{
    gate: "RED" | "GREEN" | "VERIFY";
    reason: string;
    evidence: string[];
  }>;
}
```

`failureDetails` is empty for a full pass. On failure, it lists the gate or
gates that prevented the pass with diagnostic test or verification evidence.

## Verification

Use the package scripts for repository verification:

```shell
bun run test
bun run typecheck
bun run check
bun run build
```

`bun run test` is the supported test command for this project. It runs the
Vitest suite configured in `package.json`; Bun's native test runner is not the
project suite runner.
