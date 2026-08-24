# External Trigger

Headless, project-agnostic BB doorbells for continuing one exact existing
thread. The plugin stores the target and wake instruction locally, exposes a
token-authenticated HTTP route, and keeps delivery reservations in its own
SQLite database. It has no UI, poller, daemon, provider integration, spawn
path, or bb-collab dependency.

Install the collection entry, then create a trigger:

```sh
bb plugin token external-trigger
bb external-trigger create --project proj_... --thread thr_... --instruction 'Check the external event and continue the task.'
bb external-trigger list --project proj_...
```

Send only the trigger and delivery identities. The caller cannot supply prompt
text:

```sh
curl -X POST \
  -H 'content-type: application/json' \
  -H 'x-bb-plugin-token: <token>' \
  http://127.0.0.1:<port>/api/v1/plugins/external-trigger/http/doorbell \
  -d '{"triggerId":"<id>","deliveryId":"event-123"}'
```

Each delivery is reserved before `threads.send` with `mode: auto`. A duplicate
is idempotent; any thrown or unsettled send remains reserved and is not retried.
Archived, deleted, mismatched, removed, malformed, oversized, or unknown
targets fail closed.
