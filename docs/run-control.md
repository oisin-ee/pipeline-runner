# Run control & the run directory

Moka separates **run-control state** from **on-disk observability artifacts**.

## Run-control state lives in the durable Postgres store

Since the Layer B durable substrate (PIPE-91), the run-control state — the run
**manifest**, run/node **status**, the run-control **events** log, and the
persisted **schedule** — is owned by the durable Postgres store configured via
`momokaya.db.url` (`~/.config/moka/config.yaml`). It is **not** written to the
filesystem. `moka status <run-id>`, `moka logs <run-id>`, `moka next node`, and
`moka resume` all read this state from the database, so a run is inspectable and
resumable from any machine with access to the store.

A run that has no reachable `db.url` cannot persist run-control state; the
foreground `moka run` surfaces `db.url-required` rather than silently writing a
local copy.

## The run directory holds observability artifacts

`.pipeline/runs/<runId>/` is the on-disk **observability** output for a run — a
convenience for tailing and post-mortems, never the source of truth:

```
.pipeline/runs/<runId>/
  runtime-events.jsonl          # the ordered runtime event stream for the run
  nodes/
    <nodeId>/
      stdout.jsonl              # per-node captured output
```

The runtime reporter appends these as the run progresses. Run-control state
(manifest/status/events/schedule) is in Postgres, as described above.

## Sanitized export

Use `moka export <run-id> --sanitize` before sharing a run. The sanitized export
emits a portable evidence bundle while omitting sensitive run artifacts —
prompts, agent sessions, request/response bodies, and any secrets, tokens, or
credentials captured during execution.
