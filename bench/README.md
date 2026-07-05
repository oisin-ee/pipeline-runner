# Eval harness (PIPE-83.3 / PIPE-83.6)

Measures whether the **pipeline** (and best-of-N selection) actually produces
better code than a **flat single strong agent**, so the architecture's value is
measured, not assumed (see the PIPE-83 architecture verdict). The evidence
predicts the win comes from the independent verifier + scope decomposition, not
from node count or model variety — this harness is how you check that on your
own task set.

## Task set

`bench/tasks.json` holds the fixed eval tasks (`{ id, description, accept }`).
Add a task by appending an entry with an objective `accept` condition (e.g. a
test that must pass). Keep them small and deterministic.

## Producing run records

For each task, run it through `moka run` once per **variant** and record one
result object per task+variant:

```json
{
  "task": "clamp",
  "variant": "baseline",
  "resolved": true,
  "costTokens": 1200,
  "wallMs": 90000
}
```

- `variant`: `baseline` (one strong agent, full task context, linear) vs
  `pipeline` (the full intake→red→green→verify flow). Add ablations such as
  `pipeline-no-verifier` and `pipeline-no-multimodel` to isolate which component
  carries any gain.
- `resolved`: did the run satisfy the task's `accept` condition (tests pass).
- `costTokens` / `wallMs`: cost and wall-clock for the run.

Run via the **published global package** (the moka-verification rule), not a
local build. Collect the records into a JSON array, e.g. `runs.json`.

## Scoring

```sh
moka bench --results runs.json
```

prints a per-variant comparison (resolution rate, total tokens, average
wall-clock). Compare `baseline` against `pipeline` and the ablations.
