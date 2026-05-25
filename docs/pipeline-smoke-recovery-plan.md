# Pipeline Smoke Plan

The smoke target for v1 is the YAML runtime:

```sh
pipe init
pipe validate
pipe explain-plan
pipe run "smoke task"
```

The run is valid only when `.pipeline/runners.yaml` declares runner adapters,
`.pipeline/profiles.yaml` declares profiles and grants, and
`.pipeline/pipeline.yaml` declares workflow nodes, gates, hooks, artifacts, and
output contracts.

## What A Passing Smoke Proves

- Config validation rejects missing references and unsupported capabilities
  before execution.
- The compiled DAG runs nodes in dependency order and parallelizes independent
  batches.
- Each agent node records a separate invocation boundary.
- Native runner strategy is preferred when declared capabilities allow it.
- Subprocess strategy is used for command runners and unsafe native cases.
- Gates, artifacts, retries, hooks, and schema validation control workflow
  progress deterministically.

## Fixture Requirements

Use a disposable fixture with:

- `.pipeline/pipeline.yaml`
- `.pipeline/profiles.yaml`
- `.pipeline/runners.yaml`
- prompt files and schema files referenced by YAML
- package scripts or env commands for `test` and `typecheck`
- fake runner binaries for CI tests, live runner binaries for manual smoke

Do not use legacy `--strict`, `--harness`, `PIPELINE_HARNESS`, phase profiles,
or `.pipeline/config.toml`.

## Verification

```sh
bun run typecheck
bun run check
bun run test
bun run build:cli
```
