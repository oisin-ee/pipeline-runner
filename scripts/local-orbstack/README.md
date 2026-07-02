# Local orbstack sandbox — Argo CD reconciled

Everything under `momokaya-pipeline` on the local orbstack cluster is
reconciled by Argo CD from `argocd-app.yaml` (a multi-source `Application`:
this repo's `k8s/` manifests + the same `argo-workflows` Helm chart/version/
values infra uses for momokaya's own `Application`). Nothing here is applied
by a hand-written script — the one-time steps below are each an upstream
tool's own official installer, run once, after which Argo CD's reconciliation
loop (`syncPolicy.automated` + `selfHeal`) owns the state.

## One-time bootstrap (run yourself — GitOps-only policy blocks the agent
## from running kubectl/helm)

1. Install Argo CD (official quick-start:
   <https://argo-cd.readthedocs.io/en/stable/getting_started/>):

   ```
   kubectl config use-context orbstack
   kubectl create namespace argocd
   kubectl apply -n argocd --server-side --force-conflicts \
     -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
   kubectl -n argocd rollout status deploy/argocd-server --timeout=180s
   ```

2. Install Sealed Secrets (official Helm chart:
   <https://github.com/bitnami-labs/sealed-secrets#installation>):

   ```
   helm repo add sealed-secrets https://bitnami-labs.github.io/sealed-secrets
   helm install sealed-secrets -n kube-system sealed-secrets/sealed-secrets \
     --kube-context orbstack
   ```

3. Apply the Application (the only manifest that isn't itself reconciled by
   something else -- everything it references is):

   ```
   kubectl --context orbstack apply -f scripts/local-orbstack/argocd-app.yaml
   ```

## Durable-substrate schema migration (one-time, not reconciled)

Migrations aren't continuously-reconciled state (nothing should re-apply an
already-applied migration on every sync) -- run once per new migration, the
same way any GitOps shop handles this: manually, or via an Argo Sync Hook Job.
For this sandbox, manually, using `migratePostgresSubstrate` (the same
function `resolveRunControlStore`/`resolveDurableStore` call automatically in
the real runner pod -- see `src/runtime/durable-store/postgres/migrate-substrate.ts`),
against the in-cluster Postgres via a brief port-forward:

```
kubectl --context orbstack -n momokaya-pipeline port-forward svc/pipeline-test-postgres 55432:5432 &
nub run local-orbstack:migrate -- "postgresql://postgres:localtest@localhost:55432/moka"
kill %1
```

## Credentials (sealed, not committed as plaintext, not a bash script)

`k8s/sealed-secrets/*.yaml` are `kubeseal`-encrypted -- safe to commit,
decryptable only by the Sealed Secrets controller running on orbstack. To
(re)generate one, e.g. for `oisin-bot-git-credentials`, using `oisin-bot`'s
`gh` auth (`gh auth switch --user oisin-bot`; `gh auth refresh --scopes
read:packages` if package reads 403 -- only ever acts on the *active*
account, so switch first):

```
kubectl --context orbstack -n momokaya-pipeline create secret generic oisin-bot-git-credentials \
  --from-literal=username=oisin-bot \
  --from-literal=password="$(gh auth token --user oisin-bot)" \
  --dry-run=client -o yaml \
  | kubeseal --context orbstack --format yaml \
  > scripts/local-orbstack/k8s/sealed-secrets/oisin-bot-git-credentials.yaml
```

The same pattern applies to `oisin-bot-github-auth` (key `hosts.yml`),
`npm-registry-auth` (key `npmrc`), `ghcr-pull-secret` (`kubectl create secret
docker-registry`), and `momokaya-db-dsn` (key `dsn`, value
`postgresql://postgres:localtest@pipeline-test-postgres.momokaya-pipeline.svc.cluster.local:5432/moka`).
`broker-api-key` and `pipeline-runner-event-auth` are dummy values (no real
broker/console in this sandbox) and can be sealed the same way with any
placeholder value.

Once sealed and committed to `k8s/sealed-secrets/`, add that path as a third
source in `argocd-app.yaml` and Argo CD reconciles them like everything else.

## Using the sandbox

```
moka submit --command \
  --kubeconfig ~/.orbstack/k8s/config.yml --kube-context orbstack \
  --namespace momokaya-pipeline \
  --image-pull-secret ghcr-pull-secret \
  --npm-registry-auth-secret-name npm-registry-auth \
  -- echo hello
```
