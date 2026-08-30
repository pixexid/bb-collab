# Collaboration contracts

BB owns project, thread, parent, status, lifecycle, and message delivery. This
repository adds no collaboration runtime or authority layer.

Managers run all independent tasks. They serialize only real file collisions
or dependencies; there is no fixed parallel-worker limit.

## Worker return contract

Before becoming idle, start the final response with exactly one of:

- `DONE: <result and evidence>`
- `BLOCKED: <one concrete decision or missing input>`
- `WAITING: <external event, owner, and waker>`

Progress is not terminal. Continue unless one of those states is true.

## Manager return contract

Use BB-native child threads, give each child one bounded task, and act on native
child outcomes before becoming idle. Start the final response with exactly one
of:

- `DISPATCHED: <work started>`
- `DONE: <project-level result>`
- `BLOCKED: <one concrete decision or missing input>`
- `WAITING: <external event, owner, and waker>`
- `QUIET: <why no task is startable>`

Repository-specific review, merge, deployment, and destructive-action rules
remain repository-owned.
