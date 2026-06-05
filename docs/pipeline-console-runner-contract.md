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
  "eventSink": {
    "authHeader": "Authorization",
    "url": "https://console.example/api/pipeline/runs/run-uid-1/events"
  },
  "run": {
    "projectId": "alpha",
    "requestedBy": "@agent",
    "runId": "run-uid-1"
  },
  "selector": {
    "allowCommandHooks": true,
    "workflowId": "epic-drain"
  },
  "task": {
    "prompt": "PC-27",
    "taskId": "PC-27"
  },
  "repository": {
    "branch": "main",
    "cloneUrl": "https://github.com/oisin-ee/tova.git",
    "fullName": "oisin-ee/tova",
    "owner": "oisin-ee",
    "repo": "tova",
    "sha": "0123456789abcdef0123456789abcdef01234567"
  },
  "workspace": {
    "cloneCredentialEnv": "PIPELINE_GIT_TOKEN",
    "mode": "clean-devspace"
  }
}
```

`eventSink.url` is the exact append endpoint the runner posts to. The console
resolves any requested entrypoint before creating the Job and sends
`selector.workflowId`; the runner rejects unsupported selector modes. The
`selector.allowCommandHooks` boolean is the runner-side hook policy for command
hooks in that job. It defaults to `true`, and console callers that disable hooks
must send `false` through the shared builder.

For self-contained devspace Jobs, Console sends `workspace.mode:
"clean-devspace"` plus repository clone context. The runner requires the exact
repository SHA, clones the repository into `/workspace`, checks out a
`pipeline/<taskId>` branch at that exact SHA, sets
`PIPELINE_TARGET_PATH=/workspace`, validates `devspace.yaml`, and loads the
stable `.pipeline` baseline before invoking the pipeline engine. Console must not
pre-generate or commit ticket-specific schedules; scheduled entrypoints generate
`.pipeline/runs/<runId>/schedule.yaml` and other run artifacts inside the Job.

Stable repo assets are `devspace.yaml`, `.pipeline/pipeline.yaml`,
`.pipeline/profiles.yaml`, `.pipeline/runners.yaml`, and stable prompts, rules,
schemas, and skills. Run artifacts are schedules, worktrees, agent prompts,
logs, reports, verification evidence, and PR metadata.

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
`pipeline.oisin.dev/source`, `pipeline.oisin.dev/task`,
`pipeline.oisin.dev/workflow`, plus optional
`pipeline.oisin.dev/requested-by`.

## Event Batches

The runner posts authenticated JSON batches to `eventSink.url`:

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

If payload validation fails but the runner can recover the run identity and
event sink identity, it posts a `runner.schema.validation` warning event with
normalized issue details, then posts `workflow.finish` with outcome `FAIL`, and
exits `64`. If identity is not recoverable, it writes the validation error to
stderr and exits `64` without posting events.

Runner-job environment phases are emitted as `runner.job.phase` log events. Clean
devspace runs emit checkout/workspace readiness, devspace readiness, optional
devspace smoke status, PR delivery status, and final runtime events. The PR URL
is emitted as run evidence when delivery succeeds.

## Authentication

The payload carries the header name, not the token. The runner sets
`<eventSink.authHeader>: Bearer <token>` using this lookup order:

1. `OISIN_PIPELINE_EVENT_AUTH_TOKEN`
2. `PIPELINE_EVENT_API_TOKEN`
3. `/var/run/secrets/kubernetes.io/serviceaccount/token`

If no token is available, validation fails before runtime execution starts.

Clone credentials and GitHub PR credentials are runner-side env/secrets. Payload
fields may reference env var names such as `cloneCredentialEnv`, but payloads
must never contain secret values. PR delivery uses the configured GitHub CLI auth
environment and defaults the PR head owner to `oisin-bot`; set
`PIPELINE_PR_HEAD_OWNER` only when a different bot/user is explicitly required.

## Devspace Smoke And PR Delivery

Devspace repositories can declare a stable runner smoke command in
`.pipeline/pipeline.yaml`:

```yaml
runner_job:
  devspace_smoke:
    command: bun
    args: ["run", "test:smoke"]
```

After the pipeline runtime reports `PASS`, the runner executes the configured
smoke command from `/workspace`. A failed smoke command prevents PR creation.
After verification and smoke pass, the runner creates a GitHub pull request with
`gh pr create --fill --base <repository.branch> --head oisin-bot:<branch> --repo
<repository.fullName>`. Failed runtime or smoke verification does not create a
PR.

## Boundary

The `pipeline` command is its own user-facing command and runtime. The
`runner-job` command is a separate Kubernetes/self-contained adapter that uses
the pipeline engine after preparing the workspace. The pipeline runtime does not
import runner-job modules, and there is no compatibility shim or
`kubernetes-runner` surface.

The runner executes the configured workflow using the existing TypeScript
runtime, translates runtime events, flushes final events, and exits with a
deterministic code. It does not create Kubernetes resources, query Kubernetes,
write console database records, run migrations, or import `pipeline-console`
source.
