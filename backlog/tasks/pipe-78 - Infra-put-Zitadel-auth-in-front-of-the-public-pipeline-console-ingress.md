---
id: PIPE-78
title: 'Infra: put Zitadel auth in front of the public pipeline-console ingress'
status: To Do
assignee: []
created_date: '2026-06-12 20:11'
updated_date: '2026-07-04 19:43'
labels:
  - 'repo:infra'
  - 'repo:console'
  - phase-3
  - security
dependencies: []
references:
  - report/architecture-review-2026-06-12.md
priority: high
ordinal: 9000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
pipeline-console.momokaya.ee is internet-facing TLS and the console API has no auth layer of its own (dev mode runs with auth disabled; production relies on network isolation that doesn't apply to a public ingress). Zitadel is already deployed in the cluster.

Put authentication in front of the console: either OIDC middleware at the Traefik ingress (forward-auth via oauth2-proxy against Zitadel) or first-class OIDC login in the console itself. The runner event endpoint (/api/pipeline/runner-events) must stay reachable by runner pods with its existing bearer-token auth — exclude it from the interactive auth layer. GitHub webhook endpoint likewise keeps signature-based auth.

This is the only true security item in the review — prioritize it ahead of other phase-3 work.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Unauthenticated browser requests to pipeline-console.momokaya.ee are redirected to Zitadel login
- [ ] #2 Runner pods can still POST events using the existing bearer token (verified with a live run)
- [ ] #3 GitHub webhooks still deliver successfully (signature auth path unaffected)
- [ ] #4 Local dev flow (devspace/Tilt) remains usable without cluster auth
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Execution (decision pre-made by Oisin 2026-06-12: GATEWAY FORWARD-AUTH — oauth2-proxy or Traefik OIDC middleware against Zitadel at the ingress; no in-app OIDC):
1. Implement forward-auth manifests + Zitadel app registration + exclusion rules for /api/pipeline/runner-events (bearer token) and /api/github/webhooks (signature) — model=sonnet. The opus decision step is no longer needed.
2. Verify all four ACs against the live cluster — model=sonnet, lanes parallelizable.
Authorized to commit directly to infra main (ArgoCD will sync) — verify ACs immediately after sync and revert on failure.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Decision 2026-06-12 (Oisin): gateway forward-auth via Zitadel, not in-app OIDC. Direct-to-main commits on infra authorized.

Grooming 2026-07-04 — still valid, still To Do. Verified this repo (oisin-pipeline) holds NONE of the work: no console ingress, Traefik, oauth2-proxy, forward-auth, or Zitadel manifests exist here (`rg -li zitadel|oauth2-proxy|forward-auth` → only a passing mention in docs/mcp-gateway.md; `k8s/` contains only `runner-dev/`, unrelated). The entire implementation belongs in the SEPARATE infra GitOps repo — per the Momokaya deploy standard, the pipeline-console prod Application + ingress live at infra `k8s/apps/platform/<app>.yaml` (infra-owned, ArgoCD-synced). Labels already correct (repo:infra, repo:console). Decision remains as pre-made by Oisin 2026-06-12: gateway forward-auth (oauth2-proxy / Traefik OIDC middleware against Zitadel), NOT in-app OIDC. Remaining work is entirely in the infra repo: (1) oauth2-proxy/forward-auth manifests + Zitadel app registration; (2) exclusion rules for /api/pipeline/runner-events (bearer) and /api/github/webhooks (signature); (3) verify the 4 ACs live post-sync. No code lands in oisin-pipeline for this ticket.
<!-- SECTION:NOTES:END -->
