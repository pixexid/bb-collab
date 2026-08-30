# Collaboration contracts

BB owns project, thread, parent, status, lifecycle, and message delivery. This
repository adds no collaboration runtime or authority layer.

## Operating rules

- Run every worker session in a visible BB thread; hidden or invisible agent
  sessions are not allowed.
- Give each child one bounded task and make its manager the direct parent.
- Run all useful independent work in parallel. Serialize only actual
  dependencies, semantic collisions, or file collisions; there is no fixed
  worker limit.
- Never keep an agent thread alive to poll or sleep. For external waits, use a
  native event or webhook, or a bounded one-shot automation with a named owner
  and cleanup.
- Native parent delivery, thread status, and interactions are authoritative.
  Silence does not prove delivery or success; inspect the native outcome.
- Preserve dirty or unique worktrees and exact evidence until their owner
  explicitly disposes them.
- Do not blindly retry or send duplicate instructions. Check native state and
  delivery before acting again.
- The target repository owns review, merge, deploy, and destructive-action
  policy.

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
