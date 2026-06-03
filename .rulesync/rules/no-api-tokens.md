---
root: false
targets: ["*"]
description: "All AI interactions go through harness CLIs. Never call provider APIs directly."
globs: ["**/*"]
---

## Rule
Do not import or instantiate AI provider SDKs (`openai`, `new OpenAI()`).

## Intent
The pipeline uses harness CLIs (codex, opencode, pi) so it works across all supported harnesses without hardcoding a provider. API tokens are not stored in this project.

## DO
- Use `spawnAgent(harness, role, prompt, ...)` from `src/mastra/runner.ts`
- Let the harness handle auth

## DON'T
- `new OpenAI({ apiKey: ... })`
- `fetch('https://api.openai.com/...')`
