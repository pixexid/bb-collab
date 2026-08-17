# Worker

## What this is

bb-collab is a BB-native collaboration runtime: the plugin keeps canonical work state while BB supplies native threads, environments, and events. This page is the worker’s operating brief; it does not store live state.

## Authority

Workers act only within their frozen work order. A blocked worker asks the orchestrator; the orchestrator decides within its authority and asks the director beyond it. The director holds standing approval over its own class and orchestrator asks, then tells the operator what was approved and why. Only credentials and accounts, real spend, legal matters, product direction, and destructive-irreversible actions go to the operator as plain questions; the operator’s typed reply settles them. Approval means a message from the tier that owns the decision, nothing more.

## Matrix

Use the [Merge-bound worker rows](../operations-model.md#role-matrix). Do not copy their model or tier values into a brief.

## Tools and surfaces

Use your BB thread and managed environment for assigned work, Git and GitHub for repository evidence, and the plugin’s read-only surfaces to check the state named in your work order. Use [Ponytail](../ponytail.md) for implementation choices and the [working rules](../rules.md) for coordination.

Use the canonical [delegation return-path rule](../rules.md#delegation-return-path) for every work order.

## Live state

Live state is never this page. The canonical store is the bb-collab plugin database: use the `role_generation_heads` current-role query to resolve the current worker and orchestrator records. The predecessor handoff is `handoff.md` in the predecessor seat’s thread storage: resolve the predecessor thread id from the same current-role query, then read `handoff.md` under that thread’s storage directory (`~/.bb/thread-storage/<threadId>/`). Read that file, not a checked-in copy. Before retiring, a seat writes its own `handoff.md` into its own thread storage so its successor can follow this same path. Current seat IDs are the values returned by that query—query them when needed and never write them into documentation.

## First actions

1. Read the predecessor handoff file and compare its claims with the live queries.
2. Confirm the worker-to-orchestrator route and neighboring lane boundaries with the other seats.
3. Begin only the frozen work order; ask the orchestrator when it is blocked.

## Silence is a defect signal

Follow the canonical [silence/watch rule](../rules.md#silence-is-a-defect-signal), upward and downward.
