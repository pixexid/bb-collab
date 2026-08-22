# Exec Tracking

Server-only bb plugin for llm-collab executed-evidence recording and silent
abnormal-thread wakes. It preserves the installed `exec-tracking` identity,
settings schema, SQLite schema, CLI, evidence writer, role resolver, and wake
semantics.

The external llm-collab checkout remains authoritative for
`bin/record_executed_triples.py`, `bin/resolve_role_wake.py`, project ownership,
and role-generation state. The recorder accepts only SDK source
`client/turn/requested`; the external writer observably refuses every other
source.

See [CUTOVER.md](CUTOVER.md) for the same-id source migration and rollback.
The cutover converges reviewed repository bytes and discipline while BB's host
registration metadata continues to name the legacy path through a symlink.
That explicit residual is not a second plugin owner and does not claim the
metadata moved; the retained legacy directory remains rollback material until
[get-bb/bb#2297](https://github.com/get-bb/bb/issues/2297) provides native
same-id source retirement.
