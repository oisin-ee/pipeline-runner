---
id: PIPE-53
title: K8s-native pipeline execution for quick/execute commands
status: Done
assignee: []
created_date: "2026-06-09 19:45"
updated_date: "2026-06-10 14:10"
labels:
  - epic
  - superseded
dependencies: []
priority: high
ordinal: 158000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

Make the 'quick' and 'execute' pipeline commands spawn k8s jobs by default instead of running locally. Uses @kubernetes/client-node to programmatically create ConfigMaps and Jobs. Local execution remains available via --local flag.

<!-- SECTION:DESCRIPTION:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->

This epic introduces a k8s-run CLI command that submits pipeline runs as k8s Jobs. The existing runner-job infrastructure (buildRunnerJobK8sManifest, buildRunnerJobPayload, container image) is already in place; the missing piece is programmatic submission from the workstation CLI.

<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->

Superseded by PIPE-54. Do not implement this k8s Job/--local plan; the accepted direction is the Moka submit command surface backed by Argo Workflows.

<!-- SECTION:FINAL_SUMMARY:END -->
