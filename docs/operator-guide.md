# Moka Operator Guide

This guide is for people and agents who run `@oisincoveney/pipeline` or adjust
the host resources it generates. The package CLI is `moka`.

## Command Cheat Sheet

`moka run "<task>"`

Runs the package-owned workflow runtime from the current worktree. Scheduled
entrypoints generate a schedule artifact under `.pipeline/runs/<runId>/` and run
the compiled graph through the runtime.

```shell
moka run "Implement PIPE-123"
moka run --target local --effort normal "Implement a standard local change"
moka run --schedule .pipeline/runs/<runId>/schedule.yaml "Implement PIPE-123"
moka run --workflow inspect "Inspect this repo"
moka run --read-only "Inspect this repo without edits"
```

`moka run --target remote "<task>"`

Canonical hosted submission. It builds the runner payload from the current git
context and submits an Argo Workflow to Momokaya.

```shell
moka run --target remote --effort normal "Implement PIPE-54"
moka run --target remote --effort quick "Fix the login bug"
moka run --target remote --effort thorough "Implement a full hosted graph run"
```

`moka run --target remote --schedule <path> "<task>"`

Submits an approved schedule artifact. In examples, `<path>` is usually a
`.pipeline/runs/<runId>/schedule.yaml` file.

```shell
moka run --target remote --schedule .pipeline/runs/<runId>/schedule.yaml "Implement PIPE-54"
```

`moka run --target remote --command -- <command...>`

Submits one explicit argv command as a one-task Argo Workflow.

```shell
moka run --target remote --command -- opencode run "fix this bug"
```

Flags:

- `--target` selects `local` or `remote`; `local` is the default.
- `--effort` selects `quick`, `normal`, or `thorough`; `normal` is the default.
- `--read-only` selects read mode; mode defaults to `write`.

`moka ticket`

Moka ticket selects and scopes Backlog work; moka run executes selected work.
Use Backlog CLI for task creation and editing
instead of direct markdown edits.

```shell
moka ticket graph check --root PIPE-84
moka ticket sequence --root PIPE-84 --plain
moka ticket next --root PIPE-84 --json
moka ticket next --claim --root PIPE-84
moka ticket create --dry-run "Plan a small Backlog task"
moka ticket create --apply --parent PIPE-84 "Plan and create child tasks"
moka ticket start --root PIPE-84
moka ticket start --dry-run --root PIPE-84 --effort quick --target local
```

Read-only ticket commands are `moka ticket graph check`, `moka ticket sequence`,
`moka ticket next`, `moka ticket create --dry-run`, and
`moka ticket start --dry-run`. Commands that mutate or run work are
`moka ticket next --claim`, `moka ticket create --apply`, and
`moka ticket start` without `--dry-run`: they either mutate Backlog through
Backlog CLI task creation and editing or dispatch `moka run` for the selected
ticket.

Run-control commands:

```shell
moka runs
moka status <run-id>
moka status <run-id> --watch
moka logs <run-id> [node-id]
moka stop <run-id> [node-id]
moka export <run-id> --sanitize
```

Run directories use `.pipeline/runs/<runId>/`:

```text
.pipeline/runs/<runId>/
  schedule.yaml
  manifest.json
  status.json
  events.ndjson
  nodes/<node-id>/
  artifacts/
```

`moka export <run-id> --sanitize` emits a portable evidence bundle while omitting
prompt text, session body content, secrets, tokens, and credentials.

Compatibility aliases and presets:

```shell
moka quick "Implement a focused fix"
moka execute "Implement a thorough change"
moka inspect "Explain the app structure and available checks"
moka submit "Implement PIPE-54"
moka submit "fix the login bug" --quick
moka submit "Fix the login bug" --quick
moka submit --schedule .pipeline/runs/<runId>/schedule.yaml "Implement PIPE-54"
moka submit --command -- opencode run "fix this bug"
```

`moka quick`, `moka execute`, and `moka inspect` are compatibility presets for
`moka run --effort quick`, `moka run --effort thorough`, and
`moka run --read-only`. `moka submit` is a compatibility alias for canonical
`moka run --target remote`; use `moka run --target remote` in new docs and
scripts so there is one primary hosted-run path.

`moka validate`

Validates package-owned config and compiles the selected workflow or schedule.

```shell
moka validate
moka validate --schedule .pipeline/runs/<runId>/schedule.yaml
moka validate --workflow inspect
moka validate --strict
moka validate --no-lint
```

Normal validation emits lint warnings without failing. `--strict` promotes lint
warnings to failures. `--no-lint` skips lint warnings and keeps schema/plan
validation.

`moka explain-plan`

Prints the compiled workflow topology, including batches, nodes, runners, gates,
hooks, and artifacts.

```shell
moka explain-plan
moka explain-plan --schedule .pipeline/runs/<runId>/schedule.yaml
moka explain-plan --workflow inspect
```

`moka doctor`

Checks local prerequisites and config health.

```shell
moka doctor
moka doctor --cluster
moka doctor --cluster momokaya-pipeline --kube-context momokaya
```

`moka doctor --cluster` adds value-free runner-job preflight checks for the
selected namespace, defaulting to `momokaya-pipeline`. It checks that expected
Secret objects exist by name, ExternalSecrets and `ClusterSecretStore/openbao`
report Ready status, the runner ServiceAccount has workflow RBAC, and Argo
Workflow prerequisites are reachable. It does
not read, print, decode, diff, or validate Secret values.

OpenBao and External Secrets Operator remain infrastructure-owned
prerequisites. If the doctor reports `ClusterSecretStore/openbao` or an
ExternalSecret as not Ready, fix that in the infra repo and its OpenBao ESO
runbook (`~/dev/infra/docs/runbooks/openbao-external-secrets.md`); do not repair
OpenBao, publish Secret values, or mutate ESO resources from this package.

`moka init`

Installs or refreshes the whole per-machine harness in one command: the
package's default skills, generated host-native command surfaces and MCP
entries, copied agent hooks from private `oisin-ee/agent/hooks`, and global
instruction files generated via rulesync from `oisin-ee/agent/rules`.
OpenCode is the package default runtime. The harness is always installed
globally (`~/.claude`, `~/.config/opencode`, `~/.codex`); there is no `--scope`.
`moka init` does not create repo-local `.pipeline` config files.

```shell
moka init             # install or refresh everything
moka init --check     # verify the generated harness is current; fail if stale
moka init --dry-run   # show planned changes without writing
moka init --force     # overwrite manually edited harness files
```

`--check` and `--dry-run` write nothing and skip the network skill install.
By default `moka init` refuses to overwrite manually edited hook or command
files; `--force` overwrites them. For agent hooks, Moka clones `oisin-ee/agent`,
copies files from `hooks/<host>`, and tracks installed hashes so later runs update
unchanged owned files, delete removed owned files, and (without `--force`) refuse
to clobber manual edits. There is no source override flag and no symlink mode.

Use `PIPELINE_TARGET_PATH=/path/to/repo` when invoking `moka` from outside the
target worktree.

## Momokaya Argo Execution

Canonical hosted runs use `moka run --target remote`. The compatibility
`moka submit` surface submits Argo Workflows by default. Without `--schedule`,
the command creates a schedule through the package scheduler, builds a runner payload
from the task description and current git context, creates payload/schedule
ConfigMaps, and submits an Argo Workflow that runs the graph as DAG tasks using
the package-owned runner image.

`moka run --target remote` reads the private Momokaya target from
`~/.config/moka/config.yaml`.

```yaml
momokaya:
  kubernetes:
    kubeconfig: /path/to/cluster.kubeconfig
    namespace: <workflow-namespace>
  submit:
    eventAuthSecretKey: <event-auth-secret-key>
    eventAuthSecretName: <event-auth-secret-name>
    eventUrl: <runner-event-sink-url>
    gitCredentialsSecretName: <git-credentials-secret-name>
    githubAuthSecretName: <github-auth-secret-name>
    imagePullSecretName: <image-pull-secret-name>
    opencodeAuthSecretName: <opencode-auth-secret-name>
    serviceAccountName: <runner-service-account-name>
```

```shell
moka run --target remote --effort quick "Fix the login bug"
moka run --target remote --effort thorough "Implement PIPE-54"
```

For a local cluster, point the same commands at that cluster with
`--kubeconfig <path>` and `--namespace <namespace>`:

```shell
moka run --target remote --effort quick "Fix the login bug" --kubeconfig ~/.kube/config --namespace <workflow-namespace>
```

`moka submit` remains a compatibility alias for the remote path, but new docs and
scripts should use `moka run --target remote` so hosted submission has one
canonical command. There is no separate workstation-local `submit` path; local
submission means submitting to a local Kubernetes cluster.

Pipeline Console and other TypeScript control planes should use
`@oisincoveney/pipeline/moka-submit` instead of shelling out or importing Argo
internals. The public API accepts `eventSink` for runner event delivery,
`hooks` for direct lifecycle hook declarations, and `hookPolicy` for per-run
hook execution policy. `eventSink` is not a hook mechanism; it is the transport
used by runner pods to POST durable events back to the control plane. Direct
submit hooks are normalized into deterministic internal function ids like
`moka-submit-node-finish`; non-conflicting package hooks remain intact, and a
generated id collision is rejected before submission.

### Runner Workflow Shape

The runner container entrypoint is `moka runner-command`. Validation errors exit
`64`, startup errors exit `70`, command failure exits `1`, cancellation exits
`130`, and SIGTERM/SIGINT cancellation exits `130`.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: pipeline-run-alpha-
  namespace: <workflow-namespace>
spec:
  entrypoint: pipeline
  onExit: pipeline-finalizer
  serviceAccountName: pipeline-runner
  templates:
    - name: pipeline
      dag:
        tasks:
          - name: node-one
            template: task-one
    - name: task-one
      container:
        command: [moka]
        args:
          - runner-command
          - --payload-file
          - /etc/pipeline/payload.json
          - --schedule-file
          - /etc/pipeline/schedule.yaml
    - name: pipeline-finalizer
      container:
        command: [moka]
        args:
          - runner-finalize
          - --payload-file
          - /etc/pipeline/payload.json
          - --schedule-file
          - /etc/pipeline/schedule.yaml
          - --argo-status
          - "{{workflow.status}}"
```

The package-owned Argo Workflow uses
`ghcr.io/oisin-ee/pipeline-runner:latest` with `imagePullPolicy: Always`.
Console runner settings include queue name, service account, CPU/memory
requests and limits, active deadline, TTL, event sink URL, auth header, and auth
token file path. The runner-side event auth token is mounted as a file via
Secret volume at the path configured in `events.authTokenFile`.

Expected namespace resources:

- The ServiceAccount named by `submit.serviceAccountName` with the required RBAC
- The OpenCode auth Secret named by `submit.opencodeAuthSecretName` with key
  `auth.json`
- The event auth Secret named by `submit.eventAuthSecretName` with the key named
  by `submit.eventAuthSecretKey`
- The git credentials Secret named by `submit.gitCredentialsSecretName` using
  the same key conventions as Flux `GitRepository` credentials: `username` and
  `password` for HTTPS remotes, or `identity` and `known_hosts` for SSH remotes
- The GitHub CLI auth Secret named by `submit.githubAuthSecretName` with key
  `hosts.yml`; this Secret is for `gh` and pull request delivery, not git
  clone/fetch/push authentication
- A pipeline-console event sink reachable from the pod

Credential issuance and rotation are owned by the cluster/infra layer, not by
runner payloads; existing infra repository scripts can continue to own the
operator-facing lifecycle. Recommended production setups use External Secrets
Operator or Secrets Store CSI Driver. For GitHub HTTPS, prefer a GitHub App
installation token materialized by External Secrets Operator's
`GithubAccessToken` generator with a refresh interval below the token lifetime,
then template it as `username`/`password`. For SSH, materialize `identity` and
`known_hosts` from the external secret manager. `moka submit` references
configured Secret names; it does not accept per-run secret values.

## Payload Contract

The runner payload contract lives at
`@oisincoveney/pipeline/runner-command-contract`. Submitters should create
payloads with `buildRunnerCommandPayload`, include `workflow.id` in the payload,
and can use `runnerCommandPayloadSchema` for validation or generated docs. The
runner image labels `pipeline.oisin.dev.runner-contract-version` and
`pipeline.oisin.dev.pipeline-package-version`, plus the console
`runner.expectedContractVersion` setting and
`pipeline.oisin.dev/runner-contract-version` Workflow label, give operators a
fast way to detect image/dependency skew before starting Workflows.

Troubleshooting:

- Missing payload: pass `--payload-file <path>` to `moka runner-command`; exit
  code is `64`.
- Missing schedule or task descriptor: mount `--schedule-file <path>` and
  `/etc/pipeline/task.json`; exit code is `64`.
- Schema validation: unsupported payload fields or incompatible
  `contractVersion` exit `64`; recoverable payloads also post
  `runner.schema.validation` and a failing `workflow.finish` event.
- Invalid auth: confirm the event auth token file content matches the console
  API token; 401/403 event sink responses are terminal.
- Missing target path: mount or clone the repository worktree at the path used by
  the command task; package-owned config is loaded at runtime when the command
  invokes `moka`.
- Missing agent CLI: run `moka doctor` or install the CLI required by the
  selected runner profile before starting work.
- Cancellation: console terminates the Workflow; the runner handles
  SIGTERM/SIGINT with `AbortSignal`, records cancellation/final result events,
  flushes, and exits `130`.

## Generated Host Resources

Generated invocations include:

```text
OpenCode:    /moka-quick, /moka-execute, /moka-inspect
Claude Code: /moka-quick, /moka-execute, /moka-inspect
```

`moka init` generates, for OpenCode:

- `.opencode/commands/moka-<entrypoint>.md` for `/moka-quick`, `/moka-execute`, and `/moka-inspect`
- `.opencode/agents/*.md` for primary and subagent profiles with explicit
  `permission` maps, `task` grants, and denied ungranted tools
- `.opencode/skills/*/SKILL.md` from `npx skills add`, not Moka generation
- `.opencode/plugins/pipeline-goal-context.ts` for goal-loop compaction context
- `.opencode/opencode.json` with LSP, the singleton `pipeline-gateway` MCP
  server, and pinned package-selected plugins

`moka init` also copies hook files from `oisin-ee/agent/hooks` by overlaying
`hooks/opencode/`, `hooks/claude-code/`, and `hooks/codex/` onto the host config
roots. Hook files are authored in the agent asset repo, not generated by Moka.

For Claude Code, `moka init` generates `.claude/commands/moka-<entrypoint>.md`
slash commands.

Package defaults select OpenCode for built-in profiles and runner-command
orchestration. Codex is not a supported runtime host.

## How The Package Works

The runtime is config-driven by package-owned `@oisincoveney/pipeline` defaults.
Generated host resources are installed outside `.pipeline`; `.pipeline/runs/` is
used for schedule and runtime artifacts.

Current entrypoints:

```yaml
entrypoints:
  quick:
    schedule: quick-schedule
  execute:
    schedule: execute-schedule
  inspect:
    workflow: inspect
```

Current schedule policies:

```yaml
scheduler:
  commands:
    quick:
      schedule: quick-schedule
      catalog: quick
    execute:
      schedule: execute-schedule
      catalog: execute
```

The full graph uses research, red, green, acceptance, verification, and learn
roles. The quick graph uses intake, red, green, mechanical, and verification
roles.

Scheduled entrypoints use their catalog as the seed for the planner. The
scheduler validates the returned `kind: pipeline-schedule` DAG, writes
`.pipeline/runs/<runId>/schedule.yaml`, and executes only validated schedules.

Workflow nodes are strict by `kind`:

- `kind: agent` launches a configured profile.
- `kind: command` runs a subprocess command.
- `kind: builtin` runs built-in runtime behavior.
- `kind: group` groups existing nodes behind a single dependency target.
- `kind: parallel` runs a fixed set of child nodes concurrently.

Structural parallelism in checked-in workflows is fixed in YAML. Generated
schedules can create a constrained approval-time DAG, but they cannot invent
profiles, workflows, or node-level skill overrides.

## Configuring MCP Gateway

MCP access is host-level and gateway-only. OpenCode, Claude Code, pipeline agents,
manual sessions, and CI all connect to one ToolHive/vMCP gateway URL. Do not
start upstream MCP servers from individual sessions.

Inspect or repair host config with:

```shell
moka mcp gateway config
moka mcp gateway reconcile
moka init
moka mcp gateway doctor
```

For local gateway development:

```shell
moka mcp gateway local-status
moka mcp gateway local-start
```

`moka init` writes generated command surfaces and merges the singleton gateway
server into project host config. For OpenCode, existing repo-local plugin entries
are preserved while missing package defaults such as `oc-codex-multi-auth` are
appended, and an existing `mcp.pipeline-gateway` entry is preserved. Use
`moka mcp gateway configure-host` as an explicit migration or repair command
when direct upstream MCP entries need to be removed from existing host config
with a backup. The hosted gateway requires `PIPELINE_MCP_GATEWAY_AUTHORIZATION`
in the OpenCode environment. Restart OpenCode after config changes because it
loads config at startup.

## Profile Grant Rules

Agent context is profile-owned:

```text
workflow node -> profile -> rules, skills, MCP servers, tools, filesystem, network, output
```

Nodes choose profiles; they do not carry `skills` or `mcp_servers` directly.
When one node needs special context, create a narrow profile for that node
instead of widening a shared profile.

Adding a skill always has two steps:

```yaml
skills:
  accessibility-review:
    path: .agents/skills/accessibility-review/SKILL.md

profiles:
  moka-frontend-reviewer:
    runner: opencode
    instructions:
      path: .pipeline/prompts/frontend-reviewer.md
    skills: [accessibility-review]
```

Adding MCP access has two steps: configure the gateway once and grant the
singleton gateway server to profiles that need MCP.

```yaml
mcp_gateway:
  provider: toolhive
  mode: hosted
  url: https://pipeline-mcp.momokaya.ee/mcp/
  url_env: PIPELINE_MCP_GATEWAY_URL
  authorization_env: PIPELINE_MCP_GATEWAY_AUTHORIZATION

profiles:
  moka-router:
    runner: opencode
    instructions:
      path: .pipeline/prompts/router.md
    mcp_servers: [pipeline-gateway]
```

After changing profile grants or registries, check all three surfaces:

```shell
moka validate --strict
moka explain-plan --workflow <workflow-id>
moka init --check
```

## Runner Image Verification

Before publishing `ghcr.io/oisin-ee/pipeline-runner`, verify the package and
image wiring:

```shell
bun run build
bun run typecheck
bun run test
bun run test:image
```

`bun run test:image` builds the runner image and runs an empty payload file
through `moka runner-command` with payload and event-token mounts. The smoke test
passes only when the container reaches runner validation and exits with code
`64`.
