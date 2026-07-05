---
id: PIPE-91.13
title: >-
  Provision momokaya durable Postgres in-cluster (bitnami chart + generated
  creds)
status: Done
assignee: []
created_date: "2026-06-26 19:28"
updated_date: "2026-06-26 19:34"
labels: []
dependencies: []
parent_task_id: PIPE-91
ordinal: 287000
---

## Acceptance Criteria

<!-- AC:BEGIN -->

- [ ] #1 ArgoCD app momokaya-postgres deploys bitnami/postgresql (mirror zitadel-postgres) in namespace momokaya; ArgoCD Synced+Healthy -- Evidence: argocd app shows Synced/Healthy + pod Running
- [ ] #2 momokaya-postgresql-auth secret generated in-cluster via idempotent Job (mirror tova-dev-auth/generate-secrets); never rotates a live DB password -- Evidence: secret exists with postgres-password+password keys; re-sync leaves it unchanged
- [ ] #3 db.url reachable: psql to momokaya-postgresql.momokaya.svc:5432/momokaya succeeds from in-cluster + via port-forward -- Evidence: recorded psql \l output
<!-- AC:END -->
