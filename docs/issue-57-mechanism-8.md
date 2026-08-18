# Issue #57 mechanism 8: registered waits
> Status: The assignment subsystem and lane watcher contract were removed. The assignments table remains as a schema vestige pending consumer enumeration in #192; execution_attempts remains unchanged.


The plugin-side lane watcher treats a wait as legal idle state only when the
wait registry contains a declarative record with a waiter thread, source
thread, source event (`terminal` or `failure`), and finite deadline. Missing
or malformed deadlines are refused at registration.

The watcher reads the existing BB thread and lane state. A known source event
or an expired deadline fires the wait once and wakes the waiter through the
existing agent-only continuation/steer seam. Replayed source events are
deduplicated by `waitId`. An unreadable or missing source leaves the waiter
fail-closed; it is not treated as proof that steering is safe. An idle worker
or director with no registered wait remains a wrongful idle and follows the
existing bounded steer/escalation rules.

Waiters register through the plugin's `registerWait` RPC, and registrations
plus fired-wait dedupe use the plugin awareness KV ledger; the watcher does
not write canonical SQLite rows, receipts, or events. The
director/dispatcher seat uses the same validation and bounded self-watch path.

This is the plugin bridge for #57. It does not install host supervision,
modify launchd/LaunchAgent artifacts, or retire the terminal stall guard.
