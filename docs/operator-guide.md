# Pipeline Operator Guide

This guide is for people and agents who need to run the package or adjust the
agent context it provides.

## Command Cheat Sheet

Use either binary name:

```shell
pipe ...
oisin-pipeline ...
```

`pipe "<task>"`

Runs the default workflow directly. The `pipe` binary treats a non-command first
argument as `run`.

```shell
pipe "Implement PIPE-123"
```

`pipe run "<task>"`

Runs a workflow from `.pipeline/pipeline.yaml`. Without flags, this selects the
configured `default_workflow`.

```shell
pipe run "Implement PIPE-123"
pipe run --workflow inspect "Inspect this repo"
pipe run --entrypoint epic PIPE-31
```

`pipe pipe "<task>"`

Alias for `run`.

```shell
pipe pipe "Implement PIPE-123"
```

`pipe inspect "<task>"`

Runs the configured read-only inspection entrypoint. This is equivalent to
`pipe run --entrypoint inspect ...`.

```shell
pipe inspect "Explain the app structure and available checks"
```

`pipe epic "<task-or-epic-id>"`

Runs the `epic-drain` entrypoint. The current epic flow researches the epic,
routes child tickets into fixed tracks, runs those tracks in parallel worktrees,
drain-merges passing branches, and then runs hardened review.

```shell
pipe epic PIPE-31
```

`pipe validate`

Validates the YAML config and compiles the selected workflow.

```shell
pipe validate
pipe validate --entrypoint epic
pipe validate --workflow epic-drain
pipe validate --strict
pipe validate --no-lint
```

Normal validation emits lint warnings without failing. `--strict` promotes lint
warnings to failures. `--no-lint` skips lint warnings and keeps schema/plan
validation.

`pipe explain-plan`

Prints the compiled workflow topology, including batches, nodes, runners, gates,
hooks, and artifacts.

```shell
pipe explain-plan
pipe explain-plan --entrypoint epic
pipe explain-plan --workflow inspect
```

`pipe doctor`

Checks local prerequisites and pipeline config health.

```shell
pipe doctor
```

`pipe init`

Scaffolds the default pipeline files.

```shell
pipe init
pipe init --overwrite
```

`pipe install-commands`

Generates host-native command surfaces from the YAML config.

```shell
pipe install-commands --host all
pipe install-commands --host codex --check
pipe install-commands --host opencode --dry-run
pipe install-commands --host all --force
```

Host choices are `all`, `opencode`, and `codex`.

`pipe runner-job`

Runs the in-pod backend worker entrypoint. The job reads
`OISIN_PIPELINE_RUNNER_PAYLOAD_JSON`, executes the selected workflow in
`PIPELINE_TARGET_PATH` or the current directory, and appends runtime events to
the exact `eventSink.url` provided by the console payload.

The runner job does not call the Kubernetes API. Validation errors exit `64`,
startup errors exit `70`, runtime failure exits `1`, cancellation exits `130`,
and SIGTERM/SIGINT cancellation exits `130`.

Local dry run:

```shell
export PIPELINE_TARGET_PATH=/path/to/target/repo
export OISIN_PIPELINE_EVENT_AUTH_TOKEN=dev-token
export OISIN_PIPELINE_RUNNER_PAYLOAD_JSON='{"eventSink":{"authHeader":"Authorization","url":"http://127.0.0.1:3000/api/pipeline/runs/run-uid-1/events"},"run":{"projectId":"alpha","requestedBy":"@agent","runId":"run-uid-1"},"selector":{"workflowId":"default"},"task":{"prompt":"PIPE-38","taskId":"PIPE-38"}}'
pipe runner-job
```

Kubernetes dry run shape:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  generateName: pipeline-run-alpha-
  labels:
    kueue.x-k8s.io/queue-name: momokaya-runner
    pipeline.oisin.dev/project: alpha
    pipeline.oisin.dev/run-id: run-uid-1
    pipeline.oisin.dev/source: pipeline-console
    pipeline.oisin.dev/task: PIPE-38
    pipeline.oisin.dev/workflow: default
spec:
  template:
    spec:
      serviceAccountName: pipeline-runner
      restartPolicy: Never
      containers:
        - name: runner
          image: ghcr.io/oisin-ee/pipeline-runner:latest
          env:
            - name: OISIN_PIPELINE_RUNNER_PAYLOAD_JSON
              value: '{"eventSink":{"authHeader":"Authorization","url":"https://console.example/api/pipeline/runs/run-uid-1/events"},"run":{"projectId":"alpha","runId":"run-uid-1"},"selector":{"workflowId":"default"},"task":{"prompt":"PIPE-38","taskId":"PIPE-38"}}'
```

The runner image is configured in `pipeline-console` as
`pipeline.runner.image`. Console runner settings include queue name, service
account, CPU/memory requests and limits, active deadline, TTL, backoff limit,
event sink URL, and auth header. The runner-side
`OISIN_PIPELINE_EVENT_AUTH_TOKEN` or `PIPELINE_EVENT_API_TOKEN` must match the
console API `PIPELINE_EVENT_API_TOKEN`.

Troubleshooting:

- Missing payload: set `OISIN_PIPELINE_RUNNER_PAYLOAD_JSON`; exit code is `64`.
- Invalid auth: confirm the runner token matches the console API token; 401/403
  event sink responses are terminal.
- Missing target config: set `PIPELINE_TARGET_PATH` to a repo containing
  `.pipeline/pipeline.yaml`; exit code is `64`.
- Missing agent CLI: run `pipe doctor` or install the CLI required by the
  selected runner profile before starting work.
- Cancellation: console deletes the Job; the runner handles SIGTERM/SIGINT with
  `AbortSignal`, records cancellation/final result events, flushes, and exits
  `130`.

The runner does not own the console database, event store, Job builder, Kueue
watcher, or UI. Do not add a runner-side Kubernetes API kind, database, console
deployment per run, or separate language stack for this integration.

Generated invocations include:

```text
OpenCode: /pipe, /inspect, /epic
Codex:    $pipe, $inspect, $epic
```

Set `PIPELINE_TARGET_PATH=/path/to/repo` when invoking the CLI from outside the
target worktree.

## Runner Image Verification

Before publishing `ghcr.io/oisin-ee/pipeline-runner`, verify the package
and image wiring:

```shell
bun run build
bun run typecheck
bun run test
bun run test:image
```

`bun run test:image` builds the local runner image and runs a malformed
`OISIN_PIPELINE_RUNNER_PAYLOAD_JSON` through the default `runner-job` command.
The smoke test passes only when the container reaches runner validation and
exits with code `64`.

## How The Package Works

The runtime is config-driven. These three files are the source of truth:

```text
.pipeline/runners.yaml   runner adapters and capabilities
.pipeline/profiles.yaml  reusable profiles, rules, skills, and MCP servers
.pipeline/pipeline.yaml  entrypoints, workflows, hooks, gates, and artifacts
```

Current entrypoints:

```yaml
entrypoints:
  pipe:
    workflow: default
  inspect:
    workflow: inspect
  epic:
    workflow: epic-drain
```

Current default workflow:

```text
research -> red -> green -> acceptance -> verify -> learn
```

Current `epic-drain` workflow:

```text
research -> plan -> implement(parallel: test, frontend, backend, k8s) -> merge -> review
```

Workflow nodes are strict by `kind`:

- `kind: agent` launches a configured profile.
- `kind: command` runs a subprocess command.
- `kind: builtin` runs built-in runtime behavior such as `drain-merge`.
- `kind: workflow` invokes another named workflow, optionally in an isolated
  worktree.
- `kind: parallel` runs a fixed set of child nodes concurrently.

Structural parallelism is fixed in YAML. Routing agents can decide which work
belongs to each declared track, but they do not create new tracks dynamically.

`kind: workflow` worktrees support `${runId}` and `${nodeId}`:

```yaml
worktree_root: .pipeline/runs/${runId}/frontend
```

`drain-merge` consumes the output from parallel workflow children, skips failed
or non-worktree children, checks that mergeable branches share a base SHA, and
merges passing branches into an integration branch in declaration order. It
reports conflicts for manual resolution and does not auto-resolve them.

## Adding Skills

Skills are declared in `.pipeline/profiles.yaml` under the top-level `skills`
registry:

```yaml
skills:
  accessibility-review:
    path: .agents/skills/accessibility-review/SKILL.md
```

Then grant the skill to a profile:

```yaml
profiles:
  pipeline-frontend-reviewer:
    runner: codex
    instructions:
      path: .pipeline/prompts/frontend-reviewer.md
    skills: [accessibility-review]
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
    network:
      mode: inherit
```

Workflow nodes do not accept `skills` directly. A node selects a profile, and
the profile supplies the skills:

```yaml
workflows:
  ui-review:
    nodes:
      - id: review
        kind: agent
        profile: pipeline-frontend-reviewer
```

If only one node needs a different skill set, create a narrow profile for that
node. Do not broaden a shared profile unless every node using that profile
should receive the new skill.

Skills are validated in two ways:

- The profile can only reference skills declared in the top-level registry.
- The referenced skill file must exist unless validation is intentionally run in
  a mode that allows missing lint file references. Normal `pipe validate` emits
  a warning for missing skill files; `pipe validate --strict` fails on that
  warning.

The selected runner must also advertise `capabilities.skills: true`; otherwise
validation rejects the profile grant.

## Adding MCP Servers

MCP servers are also declared in `.pipeline/profiles.yaml`, under the top-level
`mcp_servers` registry.

For a local stdio MCP server:

```yaml
mcp_servers:
  docs:
    command: npx
    args: ["-y", "@example/docs-mcp"]
    env:
      DOCS_TOKEN: token
```

For a remote HTTP MCP server:

```yaml
mcp_servers:
  memory:
    url: https://memory-mcp.momokaya.ee/mcp/
    bearer_token_env_var: MEMORY_MCP_TOKEN
    headers:
      X-Memory-Region: eu
```

Exactly one of `command` or `url` is required. `args` and `env` are only valid
for command servers. `headers` and `bearer_token_env_var` are only valid for URL
servers.

You can also reference an existing `.mcp.json` server:

```yaml
mcp_servers:
  serena:
    ref:
      path: .mcp.json
      id: serena
```

If `id` is omitted, the registry key is used:

```yaml
mcp_servers:
  backlog:
    ref:
      path: .mcp.json
```

Grant MCP servers to profiles:

```yaml
profiles:
  pipeline-router:
    runner: codex
    instructions:
      path: .pipeline/prompts/router.md
    mcp_servers: [backlog, github-readonly]
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
    network:
      mode: inherit
```

Then use that profile from a node:

```yaml
workflows:
  route:
    nodes:
      - id: plan
        kind: agent
        profile: pipeline-router
```

As with skills, nodes do not accept `mcp_servers` directly. The node gets MCP
access through its profile. For a one-off grant, create a one-off profile.

The selected runner must advertise `capabilities.mcp_servers: true`; otherwise
validation rejects the profile grant.

## Practical Pattern

Use profiles as capability bundles:

```yaml
profiles:
  pipeline-security-reviewer:
    runner: codex
    instructions:
      path: .pipeline/prompts/security-reviewer.md
    skills: [security-and-hardening, semgrep]
    mcp_servers: [serena, semgrep, github-readonly]
    tools: [read, list, grep, glob, bash]
    filesystem:
      mode: read-only
    network:
      mode: inherit
```

Then assign nodes to the smallest profile that has exactly the context they
need:

```yaml
workflows:
  security-pass:
    nodes:
      - id: review
        kind: agent
        profile: pipeline-security-reviewer
```

After changing skills, MCP servers, profiles, or workflows, run:

```shell
pipe validate --strict
pipe explain-plan --workflow <workflow-id>
pipe install-commands --host all --check
```

## Profile Grant Rules To Remember

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
  pipeline-frontend-reviewer:
    runner: codex
    instructions:
      path: .pipeline/prompts/frontend-reviewer.md
    skills: [accessibility-review]
```

Adding an MCP server also has two steps:

```yaml
mcp_servers:
  docs:
    command: npx
    args: ["-y", "@example/docs-mcp"]

profiles:
  pipeline-router:
    runner: codex
    instructions:
      path: .pipeline/prompts/router.md
    mcp_servers: [docs]
```

Remote MCP servers use `url`:

```yaml
mcp_servers:
  memory:
    url: https://memory-mcp.momokaya.ee/mcp/
    bearer_token_env_var: MEMORY_MCP_TOKEN
```

Existing MCP JSON entries can be imported by reference:

```yaml
mcp_servers:
  backlog:
    ref:
      path: .mcp.json
```

The selected runner must advertise the capability it is being asked to use:

```yaml
runners:
  codex:
    capabilities:
      skills: true
      mcp_servers: true
```

After changing profile grants or registries, check all three surfaces:

```shell
pipe validate --strict
pipe explain-plan --workflow <workflow-id>
pipe install-commands --host all --check
```
