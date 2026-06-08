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

Generates a schedule artifact for the configured `pipe` schedule and stops for
approval. The `pipe` binary treats a non-command first argument as `run`.

```shell
pipe "Implement PIPE-123"
```

`pipe run "<task>"`

Runs a static workflow from package-owned `@oisincoveney/pipeline` config, or
generates a schedule when the selected entrypoint is scheduled. Approved
schedule artifacts execute only through `--schedule`.

```shell
pipe run "Implement PIPE-123"
pipe run --schedule .pipeline/runs/<runId>/schedule.yaml "Implement PIPE-123"
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

Generates a specialized epic schedule artifact and stops for approval. Execute
the approved artifact with `pipe run --schedule <schedule.yaml>`.

```shell
pipe epic PIPE-31
```

`pipe validate`

Validates the YAML config and compiles the selected workflow.

```shell
pipe validate
pipe validate --schedule .pipeline/runs/<runId>/schedule.yaml
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
pipe explain-plan --schedule .pipeline/runs/<runId>/schedule.yaml
pipe explain-plan --workflow inspect
```

`pipe doctor`

Checks local prerequisites and pipeline config health.

```shell
pipe doctor
```

`pipe init`

Installs the default project skills and generated OpenCode/Codex host resources,
including the singleton `pipeline-gateway` MCP entries. OpenCode is the package
default runtime; Codex remains available as a compatibility runner and host
surface. It does not create repo-local `.pipeline` config files.

```shell
pipe init
```

`pipe install-commands`

Refreshes or checks generated host-native command surfaces and MCP entries
after package upgrades or manual edits. Initial setup should use `pipe init`.

```shell
pipe install-commands --host codex --check
pipe install-commands --host opencode --dry-run
pipe install-commands --host all --force
```

Host choices are `all`, `opencode`, and `codex`.

`pipe runner-job`

Runs the in-pod backend worker entrypoint. The job reads the runner payload
from a JSON file and reads the event auth token from a file path configured in
the payload's `events.authTokenFile`. It prepares `PIPELINE_TARGET_PATH` or
clones the requested repository into `/workspace`, generates a task-specific
schedule, and appends runtime events to the Console endpoint configured by
payload `events.url`.

The runner job does not call the Kubernetes API. Validation errors exit `64`,
startup errors exit `70`, runtime failure exits `1`, cancellation exits `130`,
and SIGTERM/SIGINT cancellation exits `130`.

Local dry run:

```shell
cat > /tmp/payload.json << 'EOF'
{"contractVersion":"1","run":{"id":"run-uid-1","project":"alpha","requestedBy":"@agent"},"repository":{"url":"https://github.com/oisin-ee/pipeline-runner.git","baseBranch":"main"},"task":{"kind":"prompt","prompt":"PIPE-38"},"delivery":{"pullRequest":false},"events":{"url":"http://127.0.0.1:3000/api/pipeline/runner-events","authHeader":"Authorization","authTokenFile":"/tmp/event-token"}}
EOF
echo -n "dev-token" > /tmp/event-token
PIPELINE_TARGET_PATH=/path/to/target/repo pipe runner-job --payload-file /tmp/payload.json --orchestrator codex
```

Kubernetes dry run shape (file-only, no env vars for payload or auth):

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
          imagePullPolicy: Always
          args:
            - --payload-file
            - /etc/pipeline/payload.json
            - codex
          volumeMounts:
            - name: pipeline-payload
              mountPath: /etc/pipeline/payload.json
              subPath: payload.json
              readOnly: true
            - name: pipeline-event-auth
              mountPath: /etc/pipeline/event-auth
              readOnly: true
            - name: codex-auth
              mountPath: /root/.codex
              readOnly: true
            - name: opencode-auth
              mountPath: /root/.local/share/opencode
              readOnly: true
      volumes:
        - name: pipeline-payload
          configMap:
            name: pipeline-run-alpha-payload
            items:
              - key: payload.json
                path: payload.json
        - name: pipeline-event-auth
          secret:
            secretName: pipeline-runner-event-auth
            items:
              - key: token
                path: token
        - name: codex-auth
          secret:
            secretName: codex-auth-1
            defaultMode: 0400
        - name: opencode-auth
          secret:
            secretName: opencode-auth-1
            defaultMode: 0400
```

The package-owned Kubernetes Job manifest uses
`ghcr.io/oisin-ee/pipeline-runner:latest` with `imagePullPolicy: Always`.
Console runner settings include queue name, service account, CPU/memory
requests and limits, active deadline, TTL, backoff limit, event sink URL, auth
header, and auth token file path. The runner-side event auth token is mounted
as a file via Secret volume at the path configured in `events.authTokenFile`.
Codex auth is the native file
`/root/.codex/auth.json` from Secret `codex-auth-1`; OpenCode auth is the
native file `/root/.local/share/opencode/auth.json` from Secret
`opencode-auth-1`. Do not use `CODEX_AUTH_JSON` or `OPENCODE_AUTH_JSON` env
materialization in runner Jobs. The orchestrator argument (`codex` or
`opencode`) tells the runner which agent CLI to use for node execution.

The runner payload contract lives at
`@oisincoveney/pipeline/runner-job-contract`. `pipeline-console` should create
payloads with `buildRunnerJobPayload` and can use
`runnerJobPayloadJsonSchema` for neutral validation or generated docs. The
runner image labels `pipeline.oisin.dev.runner-contract-version` and
`pipeline.oisin.dev.pipeline-package-version`, plus the console
`runner.expectedContractVersion` setting and
`pipeline.oisin.dev/runner-contract-version` Job label, give operators a fast
way to detect image/dependency skew before starting Jobs.

Troubleshooting:

- Missing payload: pass `--payload-file <path>` to the runner-job command; exit
  code is `64`.
- Schema validation: unsupported payload fields or incompatible `contractVersion`
  exit `64`; recoverable payloads also post
  `runner.schema.validation` and a failing `workflow.finish` event.
- Invalid auth: confirm the event auth token file content matches the console
  API token; 401/403 event sink responses are terminal.
- Missing target path: set `PIPELINE_TARGET_PATH` to the repository worktree the
  runner should clone or execute; package-owned config is loaded at runtime.
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

## OpenCode-First Operation

Package-owned defaults select OpenCode for built-in profiles and runner-job
orchestration. Codex compatibility stays generated through `$pipe`, `$inspect`,
`$epic`, and Codex agent config, but it is not the default package runtime.

`pipe init` and `pipe install-commands --host opencode` generate:

- `.opencode/commands/<entrypoint>.md` for `/pipe`, `/inspect`, and `/epic`;
- `.opencode/agents/*.md` for primary and subagent profiles with explicit
  `permission` maps, `task` grants, and denied ungranted tools;
- `.opencode/skills/*/SKILL.md` for package-granted skills;
- `.opencode/plugins/pipeline-goal-context.ts` for goal-loop compaction context;
- `.opencode/opencode.json` with `lsp: true`, the singleton
  `pipeline-gateway` MCP server, and `@devtheops/opencode-plugin-otel@1.1.0`.

The surfaced default ecosystem inventory also includes DCP code,
`opencode-handoff`, `opencode-background-agents`, `opencode-snip`,
`opencode-mem`, and `cupcake` as package-selected implementation inputs. The
package owns how those patterns are projected; project operators do not need to
hand-wire global OpenCode config.

The goal loop is still pipeline-owned. Continuation prompts carry current task
state, schedule node, failed gates, changed files, verifier evidence,
acceptance evidence, and the exact next requirement. Stop reasons are bounded:
complete only after verifier and acceptance evidence exist, continue when work
remains, repair when validation/gates fail, and stop when the loop hits its
configured limits. OpenCode LSP and plugin context can help the agent work, but
they are not completion evidence.

Team mode is generated as a schedule graph. The scheduler can emit parallel
specialist nodes and a reviewer/verifier path; OpenCode subagents execute the
nodes, while the pipeline owns graph dependencies, retries, deterministic
gates, merge/drain behavior, and acceptance coverage.

## Runner Image Verification

Before publishing `ghcr.io/oisin-ee/pipeline-runner`, verify the package
and image wiring:

```shell
bun run build
bun run typecheck
bun run test
bun run test:image
```

`bun run test:image` builds the local runner image and runs an empty payload
file through the `runner-job` command with a payload file and event token file
mount. The smoke test passes only when the container reaches runner validation
and exits with code `64`.

## How The Package Works

The runtime is config-driven by package-owned `@oisincoveney/pipeline` defaults.
Generated host resources are installed outside `.pipeline`; `.pipeline/runs/`
is used for schedule and runtime artifacts:

```text
defaults/runners.yaml   runner adapters and capabilities
defaults/profiles.yaml  reusable profiles, rules, skills, and MCP servers
defaults/workflows      entrypoints, workflows, hooks, gates, and artifacts
```

Current entrypoints:

```yaml
entrypoints:
  pipe:
    schedule: pipe-schedule
  inspect:
    workflow: inspect
  epic:
    schedule: epic-schedule
```

Current schedule policies:

```yaml
schedules:
  pipe-schedule:
    baseline: pipe
    planner_profile: pipeline-schedule-planner
  epic-schedule:
    baseline: epic
    planner_profile: pipeline-schedule-planner
```

Current default workflow:

```text
research -> red -> green -> acceptance -> verify -> learn
```

Current `epic-drain` workflow:

```text
research -> plan -> implement(parallel: test, frontend, backend, k8s) -> merge -> review
```

Scheduled entrypoints use their `baseline` as the seed artifact and ask
`pipeline-schedule-planner` to produce a constrained agent graph. When you run
`pipe run --entrypoint epic PIPE-41`, the scheduler extracts `PIPE-41`, loads
its Backlog child tickets, passes those work units plus the allowed
profiles/workflows to the planner, validates the returned
`kind: pipeline-schedule` DAG, writes
`.pipeline/runs/<runId>/schedule.yaml`, and stops for approval. Execute the
approved artifact separately with `pipe run --schedule <schedule.yaml>`.

Agent-generated schedules must assign each backlog child ticket exactly once
with node-level `task_context`, embed every referenced workflow in the artifact,
use only configured profiles/workflows, and keep implementation branches behind
acceptance, verification, or review coverage.

Workflow nodes are strict by `kind`:

- `kind: agent` launches a configured profile.
- `kind: command` runs a subprocess command.
- `kind: builtin` runs built-in runtime behavior such as `drain-merge`.
- `kind: workflow` invokes another named workflow, optionally in an isolated
  worktree.
- `kind: parallel` runs a fixed set of child nodes concurrently.

Structural parallelism in checked-in workflows is fixed in YAML. Scheduled
epics can generate a constrained approval-time DAG, but they still cannot
invent profiles, workflows, or node-level skill overrides.

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

## Configuring MCP Gateway

MCP access is host-level and gateway-only. Codex, OpenCode, pipeline agents,
manual sessions, and CI all connect to one ToolHive/vMCP gateway URL. Do not
start upstream MCP servers from individual sessions. Repo-aware MCP backends
must use `PIPELINE_TARGET_PATH`, the current working directory, or the runner
job's already-prepared `/workspace`; do not add an MCP-specific clone, mirror,
copy, init container, or extra repository volume.

Use the same client config shape for hosted and local gateways:

```yaml
mcp_gateway:
  provider: toolhive
  mode: hosted
  url: https://pipeline-mcp.momokaya.ee/mcp/
  url_env: PIPELINE_MCP_GATEWAY_URL
  authorization_env: PIPELINE_MCP_GATEWAY_AUTHORIZATION
  default_profile: default
  backends:
    context7:
      locality: shared-remote
      tool_prefixes: [context7]
    uidotsh:
      locality: shared-remote
      tool_prefixes: [uidotsh]
    qdrant:
      locality: repo-scoped-remote
      tool_prefixes: [qdrant]
    fallow:
      locality: repo-local
      workspace_path_source: PIPELINE_TARGET_PATH
      required: false
      tool_prefixes: [fallow]
    serena:
      locality: repo-local
      workspace_path_source: PIPELINE_TARGET_PATH
      tool_prefixes: [serena]
    backlog:
      locality: repo-local
      workspace_path_source: PIPELINE_TARGET_PATH
      tool_prefixes: [backlog]
```

For local development, use `mode: local`; sessions still connect to the gateway
URL instead of direct upstream MCP servers.

Grant MCP to profiles with the singleton server name:

```yaml
profiles:
  pipeline-router:
    runner: codex
    instructions:
      path: .pipeline/prompts/router.md
    mcp_servers: [pipeline-gateway]
```

Inspect or repair host config with:

```shell
pipe mcp gateway config
pipe mcp gateway reconcile
pipe init
pipe mcp gateway doctor
```

For local gateway development:

```shell
pipe mcp gateway local-status
pipe mcp gateway local-start
```

`pipe init` writes generated command surfaces and the
singleton gateway server into project host config. Codex receives:

```toml
# Generated by @oisincoveney/pipeline.

[mcp_servers.pipeline-gateway]
url = "https://gateway.example/mcp"

[mcp_servers.pipeline-gateway.env_http_headers]
Authorization = "PIPELINE_MCP_GATEWAY_AUTHORIZATION"
```

OpenCode receives MCP, plugin, permission, skill, and LSP projection through
generated project files. The MCP portion is:

```json
{
  "mcp": {
    "pipeline-gateway": {
      "type": "remote",
      "headers": {
        "Authorization": "{env:PIPELINE_MCP_GATEWAY_AUTHORIZATION}"
      },
      "url": "https://gateway.example/mcp"
    }
  }
}
```

Use `pipe mcp gateway configure-host` as an explicit migration or repair
command when direct upstream MCP entries need to be removed from existing host
config with a backup.

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
    mcp_servers: [pipeline-gateway]
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

Adding MCP access has two steps: configure the gateway once and grant the
singleton gateway server to profiles that need MCP.

```yaml
mcp_gateway:
  provider: toolhive
  mode: hosted
  url: https://pipeline-mcp.momokaya.ee/mcp/
  url_env: PIPELINE_MCP_GATEWAY_URL
  authorization_env: PIPELINE_MCP_GATEWAY_AUTHORIZATION
  backends:
    context7:
      locality: shared-remote
      tool_prefixes: [context7]
    backlog:
      locality: repo-local
      workspace_path_source: PIPELINE_TARGET_PATH
      tool_prefixes: [backlog]

profiles:
  pipeline-router:
    runner: codex
    instructions:
      path: .pipeline/prompts/router.md
    mcp_servers: [pipeline-gateway]
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
