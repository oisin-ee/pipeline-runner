---
name: scope
description: Use BEFORE starting any non-trivial feature, change, or fix — when turning a request, spec, or bug into a plan and a set of tickets. Produces implementation-complete tickets that are each a single, parallel-spawnable unit of work with explicit acceptance criteria and declared dependencies, ready to fan out across agents. Trigger on "plan this", "break this down", "how should we build X", "turn this into tickets", "make an epic", "scope this out".
---

# Planning

A plan is finished when an agent fleet could drain it without you in the room: every ticket is a single unit of work, spawnable in parallel, with acceptance criteria that say exactly when it's done, and a dependency graph that makes the fan-out order computable rather than guessed. Planning *is* the work — the tickets are just its output. Coast on the planning and you pay for it N times over, once per agent that picks up an under-specified ticket.

## The discipline

Don't decompose first. Decomposition is step 5. Walk the work down to bedrock, *then* cut it into pieces.

### 1. Frame it: bug or change?

- **A bug, regression, "it's broken / slow / flaky"** → you cannot plan a fix you haven't diagnosed. Run [[diagnose]] first. Its output — the root cause, the feedback loop, the correct test seam — is the input to the rest of planning. Planning around a symptom plans the wrong work.
- **A feature or change** → go to step 2.

### 2. Understand before you cut

Read the spec *and the actual code* — not your memory of the code. Map the real dependency graph: what must exist before what. For any unfamiliar library, API, CLI, generator, or version, run [[research]] — a plan built on a hallucinated command or API signature is N tickets of rework. Name the unknowns explicitly; a named unknown is a research ticket, a buried one is a mid-implementation stall.

Before you plan to *build* any non-trivial functionality — parsing, dates/timezones, auth, retries, HTTP, validation, state machines, queues, crypto, file formats — run [[library-first-development]] to decide build-vs-adopt at planning time. This is a planning-time decision, not an implementation-time one: "adopt library X" versus "hand-roll it" produces entirely different tickets, dependencies, and acceptance criteria. Discovering mid-fan-out that a ticket should have been a `npm install` is N agents of wasted work. Vet the candidate here, then either the chosen library is a stated dependency of the dependent tickets or its evaluation is its own earlier ticket.

The same rule applies to mechanical scaffolding. Before planning tickets that create migrations, models, controllers, routes, SDK clients, generated types, config stubs, locks, snapshots, or framework boilerplate, ask: **what official or local CLI generates this?** If one exists, the plan should name the exact command, flags, dry-run/create-only mode if available, expected generated files, and follow-up edits. If no CLI fits, record the checked command/docs and the reason for manual files.

Set the context budget before decomposition. Identify the rules file, relevant spec section, source files, tests, type definitions, and known gotchas each future implementer needs. If a ticket requires context that is not written down, write it down or include it in the ticket; do not rely on session memory.

### 3. Grill the plan

Before a single ticket exists, run [[grill]] — interrogate the plan one question at a time against codebase reality and the project's own glossary. Vague terms, fuzzy boundaries, unstated assumptions, and contradictions with existing code surface here, cheaply, instead of inside a half-built worktree. A plan that hasn't been grilled is a guess wearing a checklist.

### 4. Make the architecture fit

If the work introduces or strains module boundaries, run [[improve]] *before* decomposing. Decide where the depth and the seams live, then plan tickets that build that shape. Tickets that fight the architecture are the ones that collide when fanned out — two agents smearing shallow glue across the same files is a merge conflict you authored at planning time.

Run [[quality-gate]] on the planned shape before tickets exist. If the plan depends on unsafe casts, non-null assertions, giant conditional branches, manual fallbacks, duplicated condition clusters, or shallow wrappers, the plan is not ready; fix the data flow or architecture first.

### 5. Cut into atomic, parallel-spawnable tickets

This is the constraint everything else serves. **Every ticket must be all seven:**

- **One unit of work** — implementable, testable, and verifiable in a single focused agent session. An "and" in the title is two tickets. Two independent subsystems is two tickets.
- **Independently spawnable** — an agent can take it with nothing but the ticket and the repo. No "ask Sarah", no "coordinate with the other branch". A shared contract (types, an API shape, a schema) is its *own earlier ticket* that the others depend on — define it once, then the dependents fan out without colliding.
- **Acceptance-criteria-complete** — explicit, testable done-conditions. "Implement the feature" is not acceptance criteria; "`POST /tasks` returns 201 with the created task; empty title returns 422" is.
- **Dependency-declared** — it names what it depends on, so the batch order is *computed*, not eyeballed.
- **Implementation-complete** — it carries the slice of the design it owns: the interface it implements, the files it will touch, the test seam. The implementing agent should *execute* the plan, not re-derive it.
- **Library/CLI-declared** — it names the library, framework feature, package script, or generator command to use; if manual code is required, it says why the maintained path does not fit.
- **Quality-gate-clean** — it states the smell constraints for the slice: no workarounds, unsafe casts/assertions, massive branching, disabled checks, or shallow glue.

If you can't write a ticket's acceptance criteria in a few bullets, it's too big — cut it down until you can.

**Sizing guide:** XS = one file / one function or config change; S = one or two files / one component or endpoint; M = three to five files / one vertical feature slice; L = five to eight files and should be reviewed skeptically; XL = eight or more files and must be split. Prefer S and M tickets for agent work.

**No placeholders.** A ticket containing "TBD", "TODO", "implement later", "add appropriate error handling", "write tests for this", or "similar to Task N" is not implementation-complete. Repeat the concrete detail even if it feels redundant; tickets may be read out of order.

**Parallel safety check:** independent tickets can share a dependency, but they should not edit the same file in the same batch. If two same-batch tickets need the same file, split the shared contract or file setup into an earlier dependency.

**Documentation and ADRs:** Add documentation tasks only when they preserve information future implementers need: public APIs, setup/run commands, migration steps, non-obvious constraints, or architectural decisions. Write an ADR when the decision is hard to reverse, surprising without context, and came from a real trade-off.

### 6. Record them where the fleet can drain them

Use the real tooling if it's here; degrade gracefully if it isn't.

**If [Backlog.md](https://backlog.md) is available** (`backlog` CLI resolves, or the Backlog MCP server is connected for this repo), make each ticket a task:

```bash
backlog task create "Add POST /tasks endpoint" \
  --parent TASK-12 --depends-on TASK-13 \
  --ac "Returns 201 with created task" --ac "Empty title → 422" \
  --plan "Implements TaskService.create; wires route in src/api/tasks.ts" \
  --ref src/api/tasks.ts --modified-file src/api/tasks.ts
```

Group the slice under an epic (a parent task, or `--labels epic`). Then **prove the decomposition is actually parallel**:

```bash
backlog sequence list --plain
```

This computes execution batches from your declared dependencies. Read it like a verdict:
- Everything in one long chain → your tickets aren't parallel; you over-declared dependencies or cut horizontally. Re-cut.
- Two tickets in the same batch that touch the same file → a latent merge conflict. Split the shared part into an earlier ticket they both depend on.

**If backlog isn't available**, write a plan document with the same structure — one section per ticket, each with description, acceptance criteria, dependencies, and files-likely-touched — and order it into explicit parallel batches yourself.

### 7. Dispatch

**If the local `oisin-pipeline` (`pipe`) is available** (`~/dev/oisin-pipeline`, or `pipe` / `oisin-pipeline` on PATH), hand the epic to it: `pipe epic <id>` reads the epic and its sub-tickets through the Backlog MCP, routes each into a track, fans them into isolated git worktrees running the implement→verify workflow, then drain-merges and reviews. Confirm the epic and its sub-tickets exist in backlog first — the router reads them, it doesn't invent them.

**Otherwise**, spawn the agents yourself, one parallel batch from `backlog sequence` at a time: everything in a batch concurrently, barrier, next batch.

### 8. Implement with discipline

Each ticket is built with [[test]] unless it's genuinely trivial (config, copy, a rename). Fixes land per [[fix]]. Completion claims go through [[verify]]; nothing is "done" without fresh evidence.

## When NOT to do all this

A single-file change with obvious scope doesn't need an epic — just do it (with [[test]] if it's behavior). The machinery earns its keep when work is large, parallelizable, or unclear. Don't ceremony-wrap a one-liner.

## Red flags

- Decomposing before diagnosing / grilling / fixing the architecture — tickets built on a guess.
- A ticket with no acceptance criteria, or whose criteria are "it works".
- `backlog sequence` shows one sequential chain — you planned serial work and called it parallel.
- Two same-batch tickets editing the same file — a merge conflict scheduled in advance.
- Tickets that say "implement the X" with no interface, no files, no seam — the agent will re-plan, badly.
- Shared contracts discovered mid-fan-out instead of pulled into an earlier ticket.
- A ticket that plans to hand-roll something a library already does — the build-vs-adopt call ([[library-first-development]]) wasn't made at planning time.
- A migration/scaffold/codegen ticket with no CLI command, no dry-run/create-only strategy, and no reason for manual files.
- A ticket whose plan relies on a cast, assertion, fallback, suppression, massive branch, or duplicated condition cluster to make progress.

## The short version

Diagnose (if it's a bug) → understand the *real* code, deciding library-vs-hand-roll and CLI/generator-vs-manual with [[library-first-development]] → [[grill]] → fit the [[improve|architecture]] → run [[quality-gate]] on the planned shape → cut into tickets that are each *one* parallel-spawnable, acceptance-complete, dependency-declared unit → record in backlog and prove parallelism with `backlog sequence list --plain` → dispatch with `pipe epic` → build each with [[test]]. The plan is done when the fleet could drain it without you.

---

*Original work. Orchestrates [[diagnose]], [[grill]], [[improve]], and [[test]] (adapted from [mattpocock/skills](https://github.com/mattpocock/skills), MIT) with [[research]], [[library-first-development]], [[spec]], [[fix]], [[quality-gate]], and [[verify]], with context, documentation, and parallel-dispatch guidance folded in from local oisin-pipeline material. Wires to [Backlog.md](https://backlog.md) and the local `oisin-pipeline` (`pipe`) when present, and degrades to a plain plan document when not.*
