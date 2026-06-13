# Pipeline Console Runner Contract

`moka` is the runner package CLI used by the container image.
`pipeline-console` creates, lists, and cancels Kubernetes Jobs, stores events,
renders the UI, and owns Kueue/Kubernetes discovery. The runner does not own the
console database, event store, Job builder, Kueue watcher, or UI.

## Console Job Payload

`pipeline-console` starts the image with the payload JSON as a mounted
ConfigMap file and the event auth token as a mounted Secret file. The runner
reads the payload from `--payload-file` and uses `events.authTokenFile` to
locate the event auth token file.

The executable payload contract lives in this package at
`@oisincoveney/pipeline/runner-command-contract`. Console code must build runner
payloads through `buildRunnerCommandPayload` instead of hand-shaping JSON. The same
subpath exports `parseRunnerCommandPayload` and `runnerCommandPayloadSchema` for
validation, tests, and docs.

```json
{
  "contractVersion": "1",
  "run": {
    "id": "run-uid-1",
    "project": "alpha",
    "requestedBy": "@agent"
  },
  "repository": {
    "url": "https://github.com/oisin-ee/tova.git",
    "baseBranch": "main",
    "sha": "0123456789abcdef0123456789abcdef01234567"
  },
  "task": {
    "kind": "ticket",
    "id": "PC-27",
    "path": "tickets/PC-27.md",
    "title": "Fix checkout flow"
  },
  "delivery": {
    "pullRequest": true
  },
  "events": {
    "url": "https://console.example/api/pipeline/runner-events",
    "authHeader": "Authorization",
    "authTokenFile": "/etc/pipeline/event-auth/<event-auth-secret-key>"
  }
}
```

`task` must be either a prompt task or a ticket task:

```json
{ "kind": "prompt", "prompt": "Fix checkout flow", "title": "Checkout fix" }
```

```json
{ "kind": "ticket", "id": "PC-27", "path": "tickets/PC-27.md" }
```

Payloads describe run identity, repository/task intent, delivery intent, and the
Console event destination. They must not carry workflow selectors, entrypoints,
workspace modes, clone credential env names, repository owner/repo duplicates, or
secrets. `events.authTokenFile` is a path to a mounted file containing the
Console event API token; the token value itself stays in Kubernetes secrets. The
runner clones `repository.url` into `/workspace`, checks out a
`pipeline/<task-or-run>` branch from `repository.sha` when present or
`origin/<repository.baseBranch>` otherwise, sets `PIPELINE_TARGET_PATH`, loads
package-owned `@oisincoveney/pipeline` config, generates a task-specific `moka`
schedule artifact, and then invokes the pipeline engine.

Stable runtime config is package-owned. Repo-local artifacts are schedules,
worktrees, agent prompts, logs, reports, verification evidence, and PR
metadata.

Payloads declare `contractVersion: "1"`. Runner images are labeled with
`pipeline.oisin.dev.runner-contract-version` and
`pipeline.oisin.dev.pipeline-package-version`; console deployment config records
the expected payload contract as `runner.expectedContractVersion` and labels
created Jobs with `pipeline.oisin.dev/runner-contract-version`. Operators should
keep the console package dependency, console expected version, and runner image
label version aligned. A future breaking payload change must increment the
contract version and ship a compatibility plan.

Console-created Jobs are labeled with `pipeline.oisin.dev/project`,
`pipeline.oisin.dev/run-id`, `pipeline.oisin.dev/source`,
`pipeline.oisin.dev/task`, plus optional `pipeline.oisin.dev/requested-by`.

## Event Batches

Console supplies `events.url`, `events.authHeader`, and `events.authTokenFile` in
the runner payload. The runner reads the token from the configured file path
and posts progressive authenticated JSON batches to `events.url`:

```json
{
  "events": [
    {
      "at": "2026-06-02T09:00:00.000Z",
      "sequence": 1,
      "type": "node.start",
      "node": { "nodeId": "research", "status": "running" }
    }
  ]
}
```

Each event has a strictly increasing integer `sequence`, a string `type`, an
`at` timestamp, and console-detail fields such as `workflowPlan`, `edge`,
`node`, `gate`, `artifact`, `log`, and `finalResult`. The console stores
non-reserved top-level fields as event payload.

If a configured terminal sink flush fails, the Job exits `70`. If payload
validation fails but the runner can recover the run identity and event config, it
posts a `runner.schema.validation` warning event, then posts `workflow.finish`
with outcome `FAIL`, and exits `64`. If identity or event config is not
recoverable, it writes the validation error to stderr and exits `64` without
posting events.

Runner-command phases are emitted as `runner.command.phase` log events:
workspace preparation, environment readiness, optional setup, generated schedule,
optional smoke status, PR delivery status, and final runtime events. The PR URL is
emitted as run evidence when delivery succeeds.

## Environment Setup And PR Delivery

Package-owned config declares stable runner setup and smoke commands:

```yaml
runner_command:
  environment:
    setup:
      - command: bun
        args: ["install", "--frozen-lockfile"]
    smoke:
      - command: bun
        args: ["run", "test:smoke"]
```

Before runtime, the runner executes configured setup commands from `/workspace`.
After the pipeline runtime reports `PASS`, the runner executes configured smoke
commands from `/workspace`. A failed smoke command prevents PR creation.

When `delivery.pullRequest` is `true`, the runner pushes the branch and creates a
GitHub pull request with `gh pr create --fill --base <repository.baseBranch>
--head oisin-bot:<branch> --repo <owner/repo-derived-from-repository.url>`. Set
`PIPELINE_PR_HEAD_OWNER` only when a different bot/user is explicitly required.
Passing runtime delivery runs after smoke verification. Failed runtime delivery
skips smoke, still attempts to push/create the PR so produced work is inspectable,
and preserves the failed runtime outcome and exit code. Failed smoke verification
does not create a PR.

## Authentication

Secrets are mounted as files only. Payloads must never contain secret
values or secret file paths. Clone credentials, GitHub PR credentials, MCP
gateway auth, and native agent auth files are supplied by the Kubernetes Job
environment and mounted secrets.

Expected runner Job secrets and mounts include:

- The configured OpenCode auth Secret mounted at
  `/root/.local/share/opencode/auth.json`
- The configured event auth Secret mounted at
  `/etc/pipeline/event-auth/<event-auth-secret-key>`
- MCP gateway auth Secret mounted at a path referenced by the runner
- The configured git credentials Secret mounted for `git`; HTTPS remotes use
  `username` and `password`, and SSH remotes use `identity` and `known_hosts`
  following Flux `GitRepository` credential conventions
- The configured GitHub CLI auth Secret mounted for `gh` when pull request
  delivery is enabled

The runner image sets `HOME=/root`; Kubernetes must project each numbered auth
Secret with the key `auth.json` into the target directory. The runner does not
read event auth tokens or payloads from environment variables. No
`OISIN_PIPELINE_RUNNER_PAYLOAD_JSON`, `PIPELINE_EVENT_API_TOKEN`, or
`OPENCODE_AUTH_JSON` env vars are used.

Git credential issuance and rotation are cluster concerns. For GitHub HTTPS,
operators should prefer GitHub App installation tokens generated by External
Secrets Operator or equivalent control-plane automation. For SSH, operators
must provide both the private identity and pinned `known_hosts` data. Runner
payloads never carry credential values or Secret names.

## Boundary

The `moka` command is its own user-facing command and runtime. Argo
Workflow submission is the Kubernetes control plane path. The in-container
`moka runner-command` adapter executes the argv supplied by an Argo task after
validating the shared payload. The pipeline runtime does not import Kubernetes
submission modules, and there is no compatibility shim or `kubernetes-runner`
surface.

The runner executes one explicit command, translates runtime events, flushes
final events, and exits with a deterministic code. It does not create
Kubernetes resources, query Kubernetes, write console database records, run
migrations, or import `pipeline-console` source.

## Intentionally Stable Decisions

`@dagrejs/graphlib` remains the workflow graph representation, while the planner
keeps an iterative topological sort instead of graphlib's recursive topsort. The
recursive algorithm can hit call stack overflow on a deep chain, and the local
toposort preserves the graphlib ordering contract without re-opening that risk.

Runner semantic state stays in git refs under
`refs/heads/pipeline/runs/<run>/<workflow>/nodes/<node>`, not in Argo artifacts.
Argo artifacts pass files, but they do not carry merged git history or dependency
state passing; runners pre-fetch dependency refs before dependent nodes run.

The runner payload v1, event record schema, schedule artifact format, and k8s
label conventions under `pipeline.oisin.dev/*` are stable contracts for Pipeline
Console and other external consumers. Breaking changes require a contract version
bump and a compatibility plan rather than an in-place schema change.

The retry delay remains AbortSignal-aware and local to the runtime because gate
failure remediation reprompt behavior depends on abortable node retry evidence.
`p-retry` is not a drop-in replacement for that scheduler contract.

The runner event sink remains custom HTTP batching with retry semantics, not
Kubernetes events. Kubernetes events are not the automation channel; the console
needs ordered semantic event sink records, authenticated HTTP batches, and
deterministic retry failure handling.
