---
name: claude-code-opencode-execute
description: Use in Claude Code when executing Moka work locally through OpenCode; loads execute first, then spawns Claude Task agents that run opencode run with the correct MoKa agent prompts.
allowed-tools: Bash(opencode run *) Bash(pwd) Bash(git status *) Task
---

# Claude Code OpenCode Execute

Use this skill when Claude Code is the interactive host, but the work should be executed by local OpenCode MoKa agents through `opencode run` subprocesses.

This skill is a host adapter. It does not replace [[execute]]. Load and follow [[execute]] first; use this skill only for the Claude Code dispatch mechanics.

## Contract

1. Load [[execute]] and let it classify the request, required companion skills, acceptance criteria, and verification path.
2. Keep the execution doctrine from [[execute]]: vertical slices, test-first for behavior, root-cause fixes, fidelity checks, critique, and verification.
3. Use Claude Code `Task` subagents as wrappers around local OpenCode subprocesses when work can be delegated.
4. Each delegated Task agent should run exactly one MoKa-flavored OpenCode command and return the command, exit status, parsed evidence, touched files, and blockers.
5. Batch independent nodes in parallel, wait at barriers, synthesize outputs, then decide the next batch.

## OpenCode command shape

Task agents should run OpenCode with this shape from the repository root:

```sh
opencode run --agent "<MoKa Agent Name>" --format json --dir "$PWD" '<node prompt>'
```

Use `--format json` so the parent can inspect structured event output. If the output contains multiple assistant text candidates, prefer the latest candidate that satisfies the requested JSON or evidence contract.

Do not use `moka submit` for this local Claude Code adapter unless the user explicitly asks to submit an Argo Workflow. `moka submit` is the durable pipeline path; this skill is for interactive local orchestration through Claude Task agents and `opencode run`.

## Agent Selection

Select the MoKa agent by the slice's role:

| Role | OpenCode agent |
| --- | --- |
| Intake, repository research, requirements clarification | `MoKa Researcher` |
| Read-only code inspection | `MoKa Inspector` |
| Schedule graph generation or schedule review | `MoKa Schedule Planner` |
| Focused failing tests | `MoKa Test Writer` |
| Production implementation | `MoKa Code Writer` |
| Acceptance criteria audit | `MoKa Acceptance Reviewer` |
| Final quality review | `MoKa Thermo Nuclear Reviewer` |
| Verification evidence and command checks | `MoKa Verifier` |
| Durable lessons after a completed run | `MoKa Learner` |

Do not delegate normal child work to `MoKa Orchestrator`; the Claude Code parent is the local orchestrator for this adapter.

## Prompt Contract

Every `opencode run` prompt must include:

- The original user task.
- The current execution contract from [[execute]].
- The node id and role.
- The selected MoKa agent name and why it was selected.
- The exact files or modules in scope, or a read-only discovery scope.
- Dependency outputs from earlier nodes.
- The acceptance criteria this node owns.
- The output shape expected by the parent.

Use this template for delegated prompts:

```text
You are running as <MoKa Agent Name> for a Claude Code local Moka execution.

Original task:
<user task>

Execution contract:
<contract produced by execute>

Node:
- id: <node id>
- role: <role>
- selected agent: <MoKa Agent Name>
- scope: <files/modules/commands>

Dependency outputs:
<summaries or "none">

Acceptance criteria owned by this node:
<criteria>

Instructions:
- Follow the skills and grants configured for this MoKa agent.
- Stay inside this node's scope.
- Do not claim completion without fresh evidence.
- Return only the requested output shape.

Output shape:
<JSON or concise evidence contract>
```

## Batching Rules

- Run read-only discovery agents in parallel when their scopes do not require a shared conclusion first.
- Run test-writing before production implementation for behavior changes.
- Run multiple `MoKa Code Writer` agents in the same batch only when [[execute]] has produced independent vertical slices with disjoint files or clearly isolated worktrees.
- Never let two write-capable agents edit the same file in the same batch.
- Run acceptance review, final quality review, and verifier after implementation outputs have been integrated.
- If any delegated command fails, stop the batch, read the output, classify the blocker, and return to [[execute]] routing instead of retrying blindly.

## Parent Responsibilities

The Claude Code parent must:

- Inspect outputs before launching the next batch.
- Integrate or reconcile changes itself when multiple agents wrote code.
- Run the verification required by [[execute]] in the real repository context.
- Inspect the final diff for accidental edits, secrets, generated churn, and unrelated changes.
- Report partial verification honestly if the real command path cannot be exercised.

This skill is complete only when [[execute]] would allow the parent to claim completion.
