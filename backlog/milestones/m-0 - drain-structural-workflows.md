---
id: m-0
title: "drain-structural-workflows"
---

## Description

Nested-DAG workflow primitives (kind: workflow, kind: parallel) + drain-merge builtin + epic entrypoint and supporting config. Enables structural parallelism: research → plan → parallel(track-A, track-B, ...) → merge → review. Each parallel branch can be a sub-workflow with its own git worktree.
