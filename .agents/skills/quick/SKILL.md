---
description: Compact Moka pipeline entrypoint for small repository work. Use when the user asks for quick pipeline execution or a small task through Moka.
name: quick
---

# Quick

Use this skill when a task should go through the compact Moka pipeline path.

This skill is host-neutral. Do not embed host-specific command surfaces, native-agent routes, or nested agent CLI calls here. Generated host commands and agents own dispatch details for OpenCode, Codex, Claude Code, and any other supported host.

When a generated Moka command is active, follow that command's dispatch instructions. Otherwise, use the package-owned CLI entrypoint:

```sh
moka submit --quick <task description>
```

The quick path should stay compact: generate or submit the quick schedule, preserve package-owned gates, and report only the evidence returned by the pipeline runtime.

**Compact is not undisciplined.** "Quick" describes the *size* of the task, not a licence to skip the gates — the same completion contract applies: the work is finished and evidenced, or it is an explicit escalation, never a silent partial. Preserve every package-owned gate; reporting "done" still means reporting the runtime's actual evidence, not your assumption that it passed. If a task turns out to need real planning, a failing-test loop, or a root-cause investigation, it was never a quick task — route it to [[scope]], [[test]], or [[trace]] instead of forcing it through this path to save steps.
