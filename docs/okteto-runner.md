# Okteto Runner Pod

Use the Okteto inner loop for hands-on local work inside the same container
shape as Argo runner tasks. One command stands the pod up and attaches a shell:

```sh
mise run dev
```

`mise run dev` applies the runner Deployment (`k8s/runner-dev/deployment.yaml`)
into the pipeline namespace (default `momokaya-pipeline`, overridable with
`PIPELINE_DEV_NAMESPACE`) and then runs `okteto up runner`, which syncs your
local checkout onto the pod and drops you into a bash terminal at
`/workspace/oisin-pipeline`. The pod runs `ghcr.io/oisin-ee/pipeline-runner:latest`
with the `pipeline-runner` service account and `CODEX_AUTH_PER_PROJECT_ACCOUNTS=0`.

Inside the pod, run a local entrypoint:

```sh
moka run --entrypoint quick "inspect the current branch"
```

Local `moka run` uses the live terminal renderer by default after PIPE-61; no
extra output-format flag is required.

Tear it down when done:

```sh
mise run dev:down
```

`dev:down` detaches the inner loop (`okteto down runner`) and removes the runner
Deployment.

Required namespace secrets and credentials in `momokaya-pipeline`:

- `ghcr-pull-secret` for pulling the private runner image.
- `broker-api-key` with `api-key`, exposed as `BROKER_API_KEY`.
- `oisin-bot-git-credentials` with `username`, `password`, `identity`, and `known_hosts`, mounted at `/etc/pipeline/git-credentials`.
- `oisin-bot-github-auth` with `hosts.yml`, mounted at `/root/.config/gh/hosts.yml`.

Caveat: this recipe is for interactive `moka run` sessions, not Argo
`runner-command` pods. It intentionally does not mount per-run payload, schedule,
or task descriptor ConfigMaps.

Parity: the dev runner pod is the inner-loop twin of the production Argo runner
pod built by `buildRunnerArgoWorkflowManifest` in `src/argo-workflow.ts`. Keep
`k8s/runner-dev/deployment.yaml` in step with that builder (same image, service
account, env, and secret mounts) so "dev pod == prod runner pod" (the original
PIPE-62 intent) holds.
