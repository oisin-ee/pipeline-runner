---
root: false
targets: ["*"]
description: "No arbitrary Tailwind values or inline styles. Style gate enforces this."
globs: ["**/*"]
---

## Rule

No `style={{}}` inline styles and no arbitrary Tailwind values like `className="w-[123px]"`.

## Intent

Arbitrary values create non-standard UI. The style gate catches these in VERIFY.

## DO

- Use standard Tailwind utility classes
- Use CSS variables for custom values

## DON'T

- `style={{ color: 'red' }}`
- `className="w-[123px] h-[456px]"`
