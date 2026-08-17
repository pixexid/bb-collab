# Orchestrator

## What this is

bb-collab is a BB-native collaboration runtime: the plugin keeps canonical work state while BB supplies native threads, environments, and events. This page is the orchestrator’s operating brief; it does not store live state.

## Authority

The orchestrator decides within its authority and owns the worker route. Workers act within their role and take blocks to the orchestrator; decisions beyond the orchestrator go to the director. The director holds standing approval over its own class and orchestrator asks, then tells the operator what was approved and why. Only credentials and accounts, real spend, legal matters, product direction, and destructive-irreversible actions go to the operator as plain questions; the operator’s typed reply settles them. Approval means a message from the tier that owns the decision, nothing more.

## Matrix

Use the [Orchestrator rows](../operations-model.md#role-matrix). Do not copy their model or tier values into a brief.

## Tools and surfaces

Use BB threads, messages, and managed environments to assign and follow work; use Git and GitHub for repository evidence; use the plugin’s read-only surfaces for canonical state. Use [Ponytail](../ponytail.md) for implementation choices and the [working rules](../rules.md) for coordination.

Use the canonical [delegation return-path rule](../rules.md#delegation-return-path) for every work order.

## Live state

Live state is never this page. The canonical store is the bb-collab plugin database: use the `role_generation_heads` current-role query to resolve the current director, orchestrator, and worker records. The predecessor handoff is `handoff.md` in the predecessor seat’s thread storage: resolve the predecessor thread id from the same current-role query, then read `handoff.md` under that thread’s storage directory (`~/.bb/thread-storage/<threadId>/`). Read that file, not a checked-in copy. Before retiring, a seat writes its own `handoff.md` into its own thread storage so its successor can follow this same path. Current seat IDs are the values returned by that query—query them when needed and never write them into documentation.

## First actions

1. Read the predecessor handoff file and compare its claims with the live queries.
2. Confirm the director-to-orchestrator and orchestrator-to-worker routes with the director and workers.
3. Establish the current lane owners before sending a frozen work order.

## Silence is a defect signal

Follow the canonical [silence/watch rule](../rules.md#silence-is-a-defect-signal), upward and downward.
