---
name: imagegen
description: Use when generating or editing raster images with available harness image tools, including requests from brand-kit, dark-mode-image, and add-dark-mode.
---

# Imagegen

Use this skill when a task asks you to generate, edit, transform, or save raster images such as PNG, JPEG, or WebP assets. It is a first-party helper for visual asset generation and may be called directly or by `brand-kit`, `dark-mode-image`, and `add-dark-mode`.

## Harness behavior

- Use the image generation or image editing tool provided by the current harness when one is available.
- If no supported image generation/editing tool is available, stop before inventing an asset and ask the caller for the supported image workflow for this harness.
- Do not claim an image was generated unless a real tool produced or edited the asset.

## Save-path discipline

- Save project-bound generated assets under the workspace, for example `public/`, `assets/`, `src/assets/`, or another project-owned asset directory.
- Do not leave final project assets in transient agent storage, downloads folders, or temporary tool output directories.
- Return the workspace-relative path of every generated or edited asset.

## Caller contract

When called by another skill, preserve the caller's design intent, theme constraints, brand palette, dimensions, and target path. If the caller did not provide a target path, choose a project-appropriate asset path and explain it before editing references.
