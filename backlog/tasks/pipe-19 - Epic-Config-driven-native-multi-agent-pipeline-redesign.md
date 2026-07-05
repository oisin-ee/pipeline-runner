---
id: PIPE-19
title: "Epic: Config-driven native multi-agent pipeline redesign"
status: Done
assignee: []
created_date: "2026-05-24 14:16"
updated_date: "2026-05-25 09:44"
labels:
  - epic
  - pipeline
  - architecture
  - multi-agent
  - config
dependencies: []
references:
  - src/pipeline-spec.ts
  - src/index.ts
  - src/mastra/pipeline-primitive.ts
  - src/mastra/runner.ts
  - src/mastra/config.ts
  - src/mastra/gates.ts
  - src/mastra/steps
  - src/install-commands.ts
  - docs/pipeline-smoke-recovery-plan.md
documentation:
  - "https://code.codex.com/docs/en/sub-agents"
  - "https://code.codex.com/docs/en/agent-sdk/subagents"
  - "https://developers.openai.com/codex/subagents/"
  - "https://developers.openai.com/codex/noninteractive"
  - "https://opencode.ai/docs/agents/"
  - "https://opencode.ai/docs/cli/"
  - "https://moonshotai.github.io/kimi-cli/en/customization/agents.html"
  - "https://moonshotai.github.io/kimi-cli/en/customization/print-mode.html"
  - "https://pi.dev/packages/pi-subagents"
modified_files:
  - README.md
  - docs/config-architecture.md
  - docs/pipeline-smoke-recovery-plan.md
  - docs/slash-command-adapter-contract.md
  - package.json
  - src/index.ts
  - src/install-commands.ts
  - src/mastra/config.ts
  - src/mastra/pipeline-primitive.ts
  - src/mastra/runner.ts
  - src/pipeline-runtime.ts
  - src/pipeline-spec.ts
  - src/workflow-planner.ts
  - tests/cli.test.ts
  - tests/install-commands.test.ts
  - tests/pipeline-runtime.test.ts
  - tests/runner.test.ts
  - tests/tracer-bullet.test.ts
priority: high
ordinal: 19000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Redesign oisin-pipeline around one authoritative YAML workflow config, replacing hardcoded phases, profiles, prompt constants, and host-specific assumptions with explicit runners, agents, capabilities, gates, hooks, and native-preferred multi-agent execution. The goal is a clean v1 architecture with no backwards compatibility requirement: `.pipeline/pipeline.yaml` is required at runtime, `pipe init` scaffolds the default pipeline, and every configured agent boundary executes as a real separate agent or native subagent. Key locked decisions: YAML only; no JSON/TOML config support; no legacy `.pipeline/config.toml`; no profiles; no built-in Backlog tracking/status sink; workflows are DAGs of agent/command/builtin/group nodes; deterministic gates run outside the model; hooks are declarative command/builtin callbacks; skills, MCP servers, rules, tools, filesystem, and network access are explicit capabilities declared in config and granted per agent. Native host behavior should be used wherever it preserves configured semantics for Codex, Codex, OpenCode, Kimi, and Pi; subprocess-per-agent is allowed only as the fallback that still preserves real multi-agent execution.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->

- [x] #1 A fresh repository can run `pipe init` to scaffold a complete default `.pipeline/pipeline.yaml` and supporting prompt/schema/resource files.
- [x] #2 `pipe run` requires `.pipeline/pipeline.yaml` and does not silently fall back to hardcoded phases, profiles, or bundled prompts.
- [x] #3 The default research/red/green/verify/learn pipeline is represented by config, not by hardcoded runtime phase lists.
- [x] #4 Configured multi-agent workflows execute each agent node as a real separate agent boundary, either through native host subagents or a separate CLI subprocess.
- [x] #5 Agents can explicitly declare runner, instructions, rules, skills, MCP server access, tools, filesystem policy, network policy, and output contracts.
- [x] #6 Deterministic gates decide pass/fail/retry outside the model and support tests, typecheck, schema checks, command exit expectations, and custom commands.
- [x] #7 Declarative hooks can run on workflow/node/gate lifecycle events without arbitrary in-process JS or TS callbacks.
- [x] #8 Generated Codex, Codex, OpenCode, Kimi, and Pi resources derive from the YAML config as the single source of truth.
- [x] #9 All legacy profile resolution and hardcoded phase coupling is removed from the active runtime path.
- [x] #10 The redesign is covered by parser, planner, adapter, gate, hook, and CLI tests, including a test that prevents merged single-prompt execution for multi-agent workflows.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Completed the YAML-only config-driven pipeline redesign: runtime now loads and executes compiled workflow DAGs, records distinct agent boundaries, supports typed runner launch plans, explicit grants, deterministic gates/retries/artifacts/schema validation, declarative hooks, YAML-derived host resources, updated CLI commands, and architecture docs. Removed public legacy primitive/spec surfaces and verified with typecheck, lint, tests, and CLI build.

<!-- SECTION:FINAL_SUMMARY:END -->
