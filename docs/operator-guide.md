# Moka Operator Guide

This guide is for people and agents who run `@oisincoveney/pipeline` or adjust
the host resources it generates. The package CLI is `moka`.

## Command Cheat Sheet

`moka submit "<task>"`

Generates the full graph schedule for the task, builds the runner payload from
the current git context, and submits an Argo Workflow to Momokaya.

```shell
moka submit "Implement PIPE-54"
```

`moka submit "<task>" --quick`

Uses the compact graph for smaller work.

```shell
moka submit "fix the login bug" --quick
```

`moka submit --schedule <path> "<task>"`

Submits an approved schedule artifact. In examples, `<path>` is usually a
`.pipeline/runs/<runId>/schedule.yaml` file.

```shell
moka submit --schedule .pipeline/runs/<runId>/schedule.yaml "Implement PIPE-54"
```

`moka submit --command -- <command...>`

Submits one explicit argv command as a one-task Argo Workflow.

```shell
moka submit --command -- opencode run "fix this bug"
```

`moka run "<task>"`

Runs the package-owned workflow runtime from the current worktree. Scheduled
entrypoints generate a schedule artifact under `.pipeline/runs/<runId>/` and run
the compiled graph through the runtime.

```shell
moka run "Implement PIPE-123"
moka run --schedule .pipeline/runs/<runId>/schedule.yaml "Implement PIPE-123"
moka run --workflow inspect "Inspect this repo"
moka run --entrypoint quick "Implement a focused fix"
```

`moka inspect "<task>"`

Runs the configured read-only inspection entrypoint.

```shell
moka inspect "Explain the app structure and available checks"
```

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
```

`moka init`

Vendors the package's default project skills and generated OpenCode host
resources, including the singleton `pipeline-gateway` MCP entry. OpenCode is the
package default runtime. `moka init` does not create repo-local `.pipeline`
config files.

```shell
moka init
```

`moka install-commands`

Refreshes or checks generated host-native command surfaces and MCP entries after
package upgrades or manual edits. Initial setup should use `moka init`.

```shell
moka install-commands --host opencode --dry-run
moka install-commands --host all --force
```

Host choices are `all` and `opencode`.

Use `PIPELINE_TARGET_PATH=/path/to/repo` when invoking `moka` from outside the
target worktree.

## Momokaya Argo Execution

`moka submit` submits Argo Workflows by default. Without `--schedule`, it creates
a schedule through the package scheduler, builds a runner payload from the task
description and current git context, creates payload/schedule ConfigMaps, and
submits an Argo Workflow that runs the graph as DAG tasks using the package-owned
runner image.

`moka submit` uses the Momokaya default event sink unless overridden with
`PIPELINE_EVENT_URL` or `--event-url`.

```shell
export PIPELINE_EVENT_URL="https://console.example.com/api/pipeline/runner-events"
moka submit "fix the login bug" --quick
moka submit "Implement PIPE-54"
```

For a local cluster, point the same commands at that cluster with
`--kubeconfig <path>` and `--namespace <namespace>`:

```shell
moka submit "fix the login bug" --quick --kubeconfig ~/.kube/config --namespace momokaya-pipeline
```

There is no separate workstation-local `submit` path; local submission means
submitting to a local Kubernetes cluster.

### Runner Workflow Shape

The runner container entrypoint is `moka runner-command`. Validation errors exit
`64`, startup errors exit `70`, command failure exits `1`, cancellation exits
`130`, and SIGTERM/SIGINT cancellation exits `130`.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: pipeline-run-alpha-
  namespace: momokaya-pipeline
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

- ServiceAccount `pipeline-runner` with the required RBAC
- Secret `opencode-auth-1` with key `auth.json`
- Secret `pipeline-runner-event-auth` with key
  `OISIN_PIPELINE_EVENT_AUTH_TOKEN`
- Secret `oisin-bot-github-auth` with keys `gitconfig`, `git-credentials`, and
  `hosts.yml`
- A pipeline-console event sink reachable from the pod

Credential rotation is owned by the infra repository scripts. `moka submit`
references the managed Momokaya Secret names; it does not accept per-run auth
Secret overrides.

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
OpenCode: /quick, /execute, /inspect
Codex:    $quick, $execute, $inspect
```

`moka init` and `moka install-commands --host opencode` generate:

- `.opencode/commands/<entrypoint>.md` for `/quick`, `/execute`, and `/inspect`
- `.opencode/agents/*.md` for primary and subagent profiles with explicit
  `permission` maps, `task` grants, and denied ungranted tools
- `.opencode/skills/*/SKILL.md` for package-granted skills
- `.opencode/plugins/pipeline-goal-context.ts` for goal-loop compaction context
- `.opencode/opencode.json` with LSP, the singleton `pipeline-gateway` MCP
  server, and pinned package-selected plugins

Package defaults select OpenCode for built-in profiles and runner-command
orchestration. Codex compatibility stays generated through `$quick`, `$execute`,
`$inspect`, and Codex agent config, but it is not the default package runtime.

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

MCP access is host-level and gateway-only. Codex, OpenCode, pipeline agents,
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
moka install-commands --host all --check
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
