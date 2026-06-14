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

**Every claim about the repo cites the `file:line` you actually read this session — not what you assume the code probably does.** Inspection that describes the codebase from memory or inference, without having opened the files, is the same failure [[research]] forbids for external sources: a confident guess dressed as a finding. If you didn't read it, say so or go read it. "The repo doesn't contain enough evidence to answer" is a valid, valued result; a fabricated summary is not.
