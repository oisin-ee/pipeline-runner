# Pipeline Console Runner Contract

`oisin-pipeline` provides the runner package and container image.
`pipeline-console` creates, lists, and cancels Kubernetes Jobs, stores events,
renders the UI, and owns Kueue/Kubernetes discovery. The runner does not own the
console database, event store, Job builder, Kueue watcher, or UI.

## Console Job Payload

`pipeline-console` starts the image with one environment variable:
`OISIN_PIPELINE_RUNNER_PAYLOAD_JSON`.

The executable payload contract lives in this package at
`@oisincoveney/pipeline/runner-job-contract`. Console code must build runner
payloads through `buildRunnerJobPayload` instead of hand-shaping JSON. The same
subpath exports `parseRunnerJobPayload`, `RUNNER_JOB_CONTRACT_VERSION`, and
`runnerJobPayloadJsonSchema` for validation, tests, and docs.

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

Payloads describe repository and task intent only. They must not carry runner
mechanics such as event sink URLs, workflow selectors, entrypoints, workspace
modes, clone credential env names, repository owner/repo duplicates, or secrets.
The runner clones `repository.url` into `/workspace`, checks out a
`pipeline/<task-or-run>` branch from `repository.sha` when present or
`origin/<repository.baseBranch>` otherwise, sets `PIPELINE_TARGET_PATH`, loads the
repository `.pipeline` config, generates a task-specific `pipe` schedule, and
then invokes the pipeline engine.

Stable repo assets are `.pipeline/pipeline.yaml`, `.pipeline/profiles.yaml`,
`.pipeline/runners.yaml`, and stable prompts, rules, schemas, and skills. Run
artifacts are schedules, worktrees, agent prompts, logs, reports, verification
evidence, and PR metadata.

Payloads declare `contractVersion: "1"`. Runner images are labeled with
`pipeline.oisin.dev.runner-contract-version` and
`pipeline.oisin.dev.pipeline-package-version`; console deployment config records
the expected payload contract as `runner.expectedContractVersion` and labels
created Jobs with `pipeline.oisin.dev/runner-contract-version`. Operators should
keep the console package dependency, console expected version, and runner image
label version aligned. A future breaking payload change must increment the
contract version and ship a compatibility plan.

Console-created Jobs are labeled with `kueue.x-k8s.io/queue-name` and
`pipeline.oisin.dev/project`, `pipeline.oisin.dev/run-id`,
`pipeline.oisin.dev/source`, `pipeline.oisin.dev/task`, plus optional
`pipeline.oisin.dev/requested-by`.

## Event Batches

Event routing is runner environment/config, not payload. Set
`OISIN_PIPELINE_EVENT_SINK_URL` to the append endpoint. The runner sets the
authorization header from `OISIN_PIPELINE_EVENT_AUTH_HEADER` when present,
otherwise `Authorization`, and resolves the bearer token using this lookup order:

1. `OISIN_PIPELINE_EVENT_AUTH_TOKEN`
2. `PIPELINE_EVENT_API_TOKEN`
3. `/var/run/secrets/kubernetes.io/serviceaccount/token`

If the event sink URL or token is unavailable, the runner still executes with a
no-op sink. If a configured terminal sink flush fails, the Job exits `70`.

The runner posts authenticated JSON batches to `OISIN_PIPELINE_EVENT_SINK_URL`:

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

If payload validation fails but the runner can recover the run identity, it posts
a `runner.schema.validation` warning event when an event sink is configured, then
posts `workflow.finish` with outcome `FAIL`, and exits `64`. If identity is not
recoverable, it writes the validation error to stderr and exits `64` without
posting events.

Runner-job environment phases are emitted as `runner.job.phase` log events:
workspace preparation, environment readiness, optional setup, generated schedule,
optional smoke status, PR delivery status, and final runtime events. The PR URL is
emitted as run evidence when delivery succeeds.

## Environment Setup And PR Delivery

Repositories can declare stable runner setup and smoke commands in
`.pipeline/pipeline.yaml`:

```yaml
runner_job:
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

When `delivery.pullRequest` is `true`, verification and smoke pass, and the
runtime outcome is `PASS`, the runner pushes the branch and creates a GitHub pull
request with `gh pr create --fill --base <repository.baseBranch> --head
oisin-bot:<branch> --repo <owner/repo-derived-from-repository.url>`. Set
`PIPELINE_PR_HEAD_OWNER` only when a different bot/user is explicitly required.
Failed runtime or smoke verification does not create a PR.

## Authentication

Secrets are runner-side env/secrets only. Payloads must never contain secret
values or secret env-var names. Clone credentials, GitHub PR credentials, MCP
gateway auth, and agent auth JSON are supplied by the Kubernetes Job environment
and mounted secrets.

Expected runner Job env/secrets include:

- `CODEX_AUTH_JSON`
- `OPENCODE_AUTH_JSON`
- `PIPELINE_MCP_GATEWAY_AUTHORIZATION`
- event sink auth env when event posting is configured
- GitHub auth usable by both `git` and `gh`

## Boundary

The `pipeline` command is its own user-facing command and runtime. The
`runner-job` command is a separate Kubernetes/self-contained adapter that uses
the pipeline engine after preparing the workspace. The pipeline runtime does not
import runner-job modules, and there is no compatibility shim or
`kubernetes-runner` surface.

The runner executes a generated task-specific schedule using the existing
TypeScript runtime, translates runtime events, flushes final events, and exits
with a deterministic code. It does not create Kubernetes resources, query
Kubernetes, write console database records, run migrations, or import
`pipeline-console` source.
