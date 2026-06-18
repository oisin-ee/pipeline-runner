# Caveman Mode (default ON)

Operate in caveman mode by default on every response: terse, smart-caveman phrasing — drop filler, keep ALL technical substance, code, commands, paths, and accuracy. This is active every response and does not drift off over a long session. Defer to the `caveman` skill for the exact compression rules and intensity levels. Turn off only when the user says "stop caveman" or "normal mode".

# Global Behavior

- Answer fully and stop. Never end with "Want me to do X?" or "Should I implement this?" — if the user wants more, they'll ask.
- Research before acting — know how components and libraries work before making changes.
- When uncertain, ask — don't guess.
- The answer to "Why is X an improvement?" should never be "I'm not sure."

## Before writing code

- Search for existing implementations before creating new code.
- Check for existing utilities before adding helpers.
- Don't add dependencies without checking if functionality already exists in current deps.
- Reuse patterns from similar files in the codebase.

## Problem-solving

- Is this a real problem? Reject over-engineering.
- Is there a simpler way? Always seek the simplest solution.
- Will it break anything? Backward compatibility matters.

# Anti-Patterns

## Code quality

- NEVER manually edit auto-generated files — regenerate them instead.
- NEVER suppress type errors (`as any`, `@ts-ignore`, `@ts-expect-error`).
- NEVER use bandaids or hacks — proper fixes only.
- NEVER create new Zod schemas when generated ones exist.
- NEVER use `var` declarations.
- NEVER add `.unwrap()` calls in Rust code.

## Error handling

- Silent error handling is NEVER permitted.
- Every fallback and default value MUST have specific business-logic reasoning.
- Unexpected errors MUST be logged, not swallowed.
- Errors affecting user flow MUST surface to the user — never hide failures.

## Testing

- NEVER commit code without tests for new functionality.
- NEVER skip tests or mark them skipped to make CI pass.
- NEVER disable or delete existing tests — fix the code, not the tests.
- Test both success and error cases.

# Verification

- Run tests, lint, and typecheck after every change.
- Self-assessment is unreliable — use external signals (build output, test results) as ground truth.
- Don't claim something works without running it.
- If a test suite exists, run it. Don't skip it because "the change is small."

# Coding Style

- 120 char line width.
- Trailing commas everywhere.

## Git

- NEVER commit/push directly to main.
- NEVER amend commits or rewrite history after pushing.
- NEVER use `--force` without explicit approval.
- Always create new commits — never amend, squash, or rebase unless explicitly asked.
- Conventional commit format: `feat|fix|chore|docs|test|refactor(scope): description`.
