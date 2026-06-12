# DevSpace Runner Pod

Use the runner profile for hands-on local work inside the same container shape as Argo runner tasks:

```sh
devspace dev --profile runner
```

DevSpace deploys a long-lived `pipeline-runner` pod with `ghcr.io/oisin-ee/pipeline-runner:latest`, the `pipeline-runner` service account, `CODEX_AUTH_PER_PROJECT_ACCOUNTS=0`, and a synced checkout at `/workspace/oisin-pipeline`. The terminal starts in that workdir.

Inside the pod, run a local entrypoint:

```sh
moka run --entrypoint quick "inspect the current branch"
```

Local `moka run` uses the live terminal renderer by default after PIPE-61; no extra output-format flag is required.

Required namespace secrets and credentials in `momokaya-pipeline`:

- `ghcr-pull-secret` for pulling the private runner image.
- `opencode-auth-1` with `auth.json`, mounted at `/root/.local/share/opencode/auth.json`.
- `oisin-bot-git-credentials` with `username`, `password`, `identity`, and `known_hosts`, mounted at `/etc/pipeline/git-credentials`.
- `oisin-bot-github-auth` with `hosts.yml`, mounted at `/root/.config/gh/hosts.yml`.

Caveat: this recipe is for interactive `moka run` sessions, not Argo `runner-command` pods. It intentionally does not mount per-run payload, schedule, or task descriptor ConfigMaps.
