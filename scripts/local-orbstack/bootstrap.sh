#!/usr/bin/env bash
# One-time local dev bootstrap: install the same Argo Workflows Helm release
# infra uses for momokaya (see infra repo k8s/apps/system/argo-workflows.yaml,
# chart argo-helm/argo-workflows@0.45.22) onto a local OrbStack cluster, plus
# the dummy Secrets `moka submit` expects to exist by name so a workflow pod
# schedules. Run this yourself against your own orbstack context — it is not
# run by the agent (GitOps-only policy blocks imperative kubectl/helm here).
#
# Usage: bash scripts/local-orbstack/bootstrap.sh
set -euo pipefail

CONTEXT=orbstack
NAMESPACE=momokaya-pipeline
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> installing argo-workflows ${NAMESPACE} on --context ${CONTEXT}"
helm upgrade --install argo-workflows argo-workflows \
  --repo https://argoproj.github.io/argo-helm \
  --version 0.45.22 \
  --kube-context "$CONTEXT" \
  --namespace "$NAMESPACE" \
  --create-namespace \
  -f "$SCRIPT_DIR/values-argo-workflows.yaml"

echo "==> creating pipeline-runner ServiceAccount + local-only admin binding"
kubectl --context "$CONTEXT" -n "$NAMESPACE" create serviceaccount pipeline-runner \
  --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f -
# Local sandbox only: skip tuning the executor Role/RoleBinding the chart
# creates and just grant this SA cluster-admin in-cluster. Never do this
# against momokaya or any shared cluster.
kubectl --context "$CONTEXT" create clusterrolebinding pipeline-runner-local-admin \
  --clusterrole=cluster-admin \
  --serviceaccount="${NAMESPACE}:pipeline-runner" \
  --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f -

echo "==> creating ghcr pull secret from your gh CLI auth (the runner image is private)"
kubectl --context "$CONTEXT" -n "$NAMESPACE" create secret docker-registry ghcr-pull-secret \
  --docker-server=ghcr.io \
  --docker-username="$(gh api user --jq .login)" \
  --docker-password="$(gh auth token)" \
  --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f -

echo "==> creating dummy secrets moka submit expects by name"
# momokaya.submit.dbAuth is read unconditionally from global config regardless
# of --kube-context (see the follow-up fix under discussion) -- stub the
# secret it names so local submits don't need that fixed first.
kubectl --context "$CONTEXT" -n "$NAMESPACE" create secret generic momokaya-db-dsn \
  --from-literal=dsn=postgresql://local-dev-dummy \
  --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f -
kubectl --context "$CONTEXT" -n "$NAMESPACE" create secret generic broker-api-key \
  --from-literal=api-key=local-dev-dummy \
  --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f -
echo "==> creating real git/github auth secrets from your gh CLI auth"
# The runner's own setup step (moka init) clones the private oisin-ee/agent
# repo for skills regardless of the task being run, so these need real
# access -- not dummy values like the other stub secrets above.
GH_LOGIN="$(gh api user --jq .login)"
GH_TOKEN_VALUE="$(gh auth token)"
kubectl --context "$CONTEXT" -n "$NAMESPACE" create secret generic oisin-bot-git-credentials \
  --from-literal=username="$GH_LOGIN" \
  --from-literal=password="$GH_TOKEN_VALUE" \
  --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f -
kubectl --context "$CONTEXT" -n "$NAMESPACE" create secret generic oisin-bot-github-auth \
  --from-literal=hosts.yml="github.com:
    oauth_token: ${GH_TOKEN_VALUE}
    user: ${GH_LOGIN}
    git_protocol: https
" \
  --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f -
kubectl --context "$CONTEXT" -n "$NAMESPACE" create secret generic pipeline-runner-event-auth \
  --from-literal=OISIN_PIPELINE_EVENT_AUTH_TOKEN=local-dev-dummy \
  --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f -

echo "==> waiting for the argo-workflows controller to be ready"
kubectl --context "$CONTEXT" -n "$NAMESPACE" rollout status deployment/argo-workflows-workflow-controller --timeout=120s

echo "done"
