---
name: verify
description: "Use before claiming work is complete, fixed, passing, ready, or safe to merge. Requires fresh verification evidence: run the relevant command or check, read the output, confirm the original criteria, and report the actual result rather than assuming success."
---

# Verify Before Claiming

Claiming work is complete without fresh evidence is not efficiency. It is guessing.

**Core rule:** evidence before claims, always.

## The Gate

Before saying anything is done, fixed, passing, ready, safe, or complete:

1. **Identify the claim.** What exactly are you about to assert?
2. **Name the evidence.** Which command, check, reproduction, or checklist would prove it?
3. **Run the full check fresh.** Do not rely on an earlier run, another agent's report, or "should pass".
4. **Read the output.** Check exit code, failures, warnings, skipped tests, and whether the command covered the claim.
5. **Report only what the evidence supports.** If verification failed or was partial, say that.

Skip any step and you have not verified.

## Evidence Map

| Claim | Requires | Not enough |
|---|---|---|
| Tests pass | Fresh test command output with 0 failures | Previous run, "should pass" |
| Build succeeds | Fresh build command with exit 0 | Lint passing |
| Linter clean | Linter output with 0 errors | Partial file check |
| Bug fixed | Original repro no longer fails, plus regression test where possible | Code changed |
| Regression test works | Red-green evidence: it fails without the fix and passes with it | Test passes once |
| Requirements met | Acceptance criteria checked one by one | Tests passing alone |
| Review ready | Diff inspected, commands run, known gaps stated | "Looks good" |
| Quality gate clean | [[quality-gate]] applied plus lint/type/static checks where available | Tests passing while casts/workarounds/smells remain |
| Agent work complete | VCS diff and verification checked independently | Agent reports success |

## Red Flags

Stop if you are about to write:

- "done", "fixed", "passes", "ready", "works", "looks good"
- "should", "probably", "seems to", "I think"
- "the agent says it passed"
- "I only changed X, so no need to run Y"
- "linter passed, so build is fine"
- "I'll verify later"

These phrases are not banned; unsupported claims are. Run the check first, then use precise language.

## If You Cannot Verify

Say exactly what is missing:

- "I could not run `npm test` because dependencies are not installed."
- "I verified the unit tests, but not the browser flow."
- "The original bug requires production data I do not have."
- "The check failed: 3 tests still fail in `billing.test.ts`."

Then either fix the blocker, ask for the missing access/input, or report the remaining risk. Do not convert uncertainty into a success claim.

## Common Patterns

**Bug fix:**

1. Reproduce the original symptom.
2. Add or keep a regression test at the right seam.
3. Watch it fail without the fix when practical.
4. Apply the fix.
5. Watch the regression test pass.
6. Re-run the original repro.

**Feature/task completion:**

1. Re-read the acceptance criteria.
2. Check each criterion directly.
3. Apply [[quality-gate]] to the diff.
4. Run the relevant test/build/lint/static-analysis commands.
5. Report completed criteria and any gaps.

**Delegated work:**

1. Read the worker's summary.
2. Inspect the diff.
3. Apply [[quality-gate]] to the diff, especially casts/assertions/workarounds/suppressions.
4. Run the relevant verification yourself.
5. Report your evidence, not the worker's confidence.

## Output Standard

A verified claim includes the evidence:

```text
Verified: `npm test -- --runInBand` passed, 142/142 tests, exit 0.
```

A partial claim says what is partial:

```text
Partially verified: unit tests passed, but I could not run Playwright because browsers are not installed.
```

## The Bottom Line

No shortcut turns confidence into evidence. Run the check, read the output, apply the quality gate, then state the result.

---

*Canonical verification handle. Adapted from local oisin-pipeline `verification-before-completion` and the verification gate in [[fix]]. Pairs with [[test]], [[fix]], [[scope]], [[quality-gate]], and [[critique]].*
