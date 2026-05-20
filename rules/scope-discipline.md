---
rule: scope-discipline
intent: Each agent role has a defined file scope. test-writer writes tests, code-writer writes src.
---

## Rule
Agents must stay within their assigned file scope.

## Intent
Role separation prevents agents from contaminating each other's work and makes verification clean.

## DO
- researcher: read only, output research.json
- test-writer: write *.test.ts / *.spec.ts only
- code-writer: write src/**/*.ts only (no test files)
- verifier: read only, output verdict JSON to stdout

## DON'T
- code-writer modifying test files
- test-writer writing implementation
- verifier writing any files
