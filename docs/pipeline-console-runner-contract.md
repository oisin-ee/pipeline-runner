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
  }
}
```

`eventSink.url` is the exact append endpoint the runner posts to. The console
resolves any requested entrypoint before creating the Job and sends
`selector.workflowId`; the runner rejects unsupported selector modes. The
`selector.allowCommandHooks` boolean is the runner-side hook policy for command
hooks in that job. It defaults to `true`, and console callers that disable hooks
must send `false` through the shared builder.

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

## Authentication

The payload carries the header name, not the token. The runner sets
`<eventSink.authHeader>: Bearer <token>` using this lookup order:

1. `OISIN_PIPELINE_EVENT_AUTH_TOKEN`
2. `PIPELINE_EVENT_API_TOKEN`
3. `/var/run/secrets/kubernetes.io/serviceaccount/token`

If no token is available, validation fails before runtime execution starts.

## Boundary

The runner executes the configured workflow using the existing TypeScript
runtime, translates runtime events, flushes final events, and exits with a
deterministic code. It does not create Kubernetes resources, query Kubernetes,
write console database records, run migrations, or import `pipeline-console`
source.
