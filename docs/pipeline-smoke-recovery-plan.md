# Pipeline Smoke Recovery Plan

## Intent

The goal is not to prove any legacy profile dispatch path. The goal is that:

```sh
pipe --strict --harness <claude|codex|opencode|pi>
```

can complete the full lifecycle reliably:

```text
research -> RED -> GREEN -> VERIFY -> LEARN
```

A passing smoke run means every harness can:

- run all five phases without hanging
- create valid research, test, source, verify, and learn artifacts
- enforce gates correctly
- exit with PASS only when the full pipeline actually passed

## Why It Is Failing

The current branch verifies only part of the system: direct subprocess dispatch
and gate mechanics. The four-harness smoke is failing because downstream
contracts are still loose or mismatched.

- `claude` proves agents can write files, but VERIFY is mis-parsing or
  mis-classifying a passing verifier result.
- `codex` is launched without a strong enough noninteractive write/approval
  contract, so it can decline file writes.
- `opencode` can stall in auth, model, or permission setup, and the runner has
  no timeout or diagnostic boundary.
- `pi` is using a custom RPC stdin loop that does not reliably emit `agent_end`;
  Pi's CLI supports simpler noninteractive print/json mode.
- `.pipeline/research.json` is not a trusted structured artifact; launcher or
  harness stdout can contaminate what the pipeline treats as research.
- LEARN must not write local markdown knowledge files; it needs to prove that
  `qdrant-store` succeeded.
- Strict smoke is using real live agents against an unsuitable repo shape, so
  model variance and missing project scripts mask runner bugs.

## Key Changes

- **Runner contracts:** Make each harness invocation explicit, timed, and
  diagnosable. Add timeouts, capture stdout/stderr separately, and report the
  harness argv in failure evidence.
- **Codex write mode:** Launch Codex with noninteractive workspace-write,
  approval-never config, and only use sandbox bypass behind an opt-in smoke env
  flag.
- **OpenCode stability:** Add `--dangerously-skip-permissions` and fail with
  timeout evidence instead of hanging indefinitely.
- **Pi stability:** Replace the custom RPC stdin loop with
  `pi --print --mode json --no-session` and attach context via file/message.
- **Research gate:** Require valid `.pipeline/research.json` with non-empty
  `findings` and `ac`; do not accept arbitrary stdout as research success.
- **Verify gate:** Parse verifier output robustly across plain JSON, JSONL
  events, nested event payloads, and object-shaped evidence.
- **Learn gate:** Return a structured LEARN result with qdrant status; fail
  LEARN if qdrant was required but no store succeeded.
- **Config-driven resources:** Generate host resources from
  `.pipeline/pipeline.yaml`; do not depend on external profile packages or
  phase-specific profile mappings.
- **Smoke fixture:** Add a disposable language-agnostic fixture with configured
  project test/typecheck commands instead of using `/Users/oisin/dev/infra` or
  baking any one framework into the smoke target.

## Test Plan

- Add focused unit tests for harness argv, timeout handling, research
  validation, verifier parsing, and LEARN/qdrant result handling.
- Keep the fake-executable tracer test to prove pipeline mechanics without live
  AI CLIs.
- Run rulesync generation for each target and assert no launcher stdout
  contaminates harness output and no unwanted worktree `node_modules` appears.
- Run live smoke against fresh disposable fixtures:
  - `pipe --strict --harness claude`
  - `pipe --strict --harness codex`
  - `pipe --strict --harness opencode`
  - `pipe --strict --harness pi`
- Run the final repository checks:

```sh
bun run test
bun run typecheck
bun run check
bun run build
```

## Assumptions

- A smoke failure in any phase is a blocker, not follow-up work.
- The smoke target should be deterministic and disposable.
- Qdrant success is part of LEARN unless memory is explicitly disabled for the
  run.
- Soft orchestrator subagents and strict subprocess agent boundaries are
  separate concepts and should not share ambiguous names.
