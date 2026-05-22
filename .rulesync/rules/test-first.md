---
root: false
targets: ["*"]
description: "Tests are written before implementation. The RED gate enforces this mechanically."
globs: ["**/*"]
---

## Rule
Write tests before writing implementation. Tests must fail (exit non-zero) before implementation is written.

## Intent
TDD is enforced mechanically by the pipeline: the RED step checks that test exit code is non-zero. A trivially-passing test (exit 0 on empty implementation) is rejected.

## DO
- Write tests that import from the implementation path
- Verify tests fail before writing implementation

## DON'T
- Write implementation before tests
- Write tests that pass without an implementation
