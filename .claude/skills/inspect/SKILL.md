---
description: Read-only repository inspection. Use when the user asks to inspect code, explain repository state, or gather findings without editing files.
name: inspect
---

# Inspect

Use this skill for read-only repository inspection.

This skill is host-neutral. Do not embed host-specific command surfaces, native-agent routes, or nested agent CLI calls here. Generated host commands and agents own dispatch details for OpenCode, Codex, Claude Code, and any other supported host.

When a generated Moka command is active, follow that command's dispatch instructions. Otherwise, inspect directly with the available read/search tools and keep the work read-only:

- identify the files, tests, docs, and config relevant to the user's question;
- summarize findings with file references;
- avoid edits, commits, generated output, or destructive commands;
- report uncertainty when the repository does not contain enough evidence.
