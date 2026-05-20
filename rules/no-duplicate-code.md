---
rule: no-duplicate-code
intent: No copy-pasted code blocks. jscpd gate enforces this with 50-token minimum.
---

## Rule
No duplicate code blocks of 50+ tokens. Enforced by jscpd in the VERIFY phase.

## Intent
Duplicate code creates drift. The jscpd static gate catches it before merge.

## DO
- Extract shared logic into named functions
- Import from shared modules

## DON'T
- Copy-paste code between files
- Duplicate error handling patterns inline
