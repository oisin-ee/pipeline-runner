---
rule: no-api-tokens
intent: All AI interactions go through harness CLIs. Never call Anthropic/OpenAI APIs directly.
---

## Rule
Do not import or instantiate AI provider SDKs (`@anthropic-ai/sdk`, `openai`, `new Anthropic()`).

## Intent
The pipeline uses harness CLIs (claude, codex, opencode, pi) so it works across all supported harnesses without hardcoding a provider. API tokens are not stored in this project.

## DO
- Use `spawnAgent(harness, role, prompt, ...)` from `src/mastra/runner.ts`
- Let the harness handle auth

## DON'T
- `import Anthropic from '@anthropic-ai/sdk'`
- `new OpenAI({ apiKey: ... })`
- `fetch('https://api.anthropic.com/...')`
