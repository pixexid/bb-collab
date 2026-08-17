# Director

## What this is

bb-collab is a BB-native collaboration runtime: the plugin keeps canonical work state while BB supplies native threads, environments, and events. This page is the director’s operating brief; it does not store live state.

## Authority

The director holds standing approval for its own decision class and for orchestrator asks. Workers act within their role and take blocks to the orchestrator; the orchestrator decides within its authority and takes the rest to the director. The director approves, then tells the operator in plain language what was approved and why; informing is not asking. Only credentials and accounts, real spend, legal matters, product direction, and destructive-irreversible actions go to the operator as plain questions. The operator’s typed reply settles those questions. Approval means a message from the tier that owns the decision, nothing more.

## Matrix

Use the [Director row](../operations-model.md#role-matrix). Do not copy its model or tier values into a brief.

## Tools and surfaces

Use BB threads and messages to coordinate, managed environments for work, Git and GitHub for repository evidence, and the plugin’s read-only surfaces for canonical state. Use [Ponytail](../ponytail.md) for implementation choices and the [working rules](../rules.md) for coordination.

## Live state

Live state is never this page. The canonical store is the bb-collab plugin database: use the `role_generation_heads` current-role query to resolve the current director and orchestrator records. The predecessor handoff file is the file named by the active seat’s handoff location; read that file, not a checked-in copy. Current seat IDs are the values returned by that query—query them when needed and never write them into documentation.

## First actions

1. Read the predecessor handoff file and compare its claims with the live queries.
2. Confirm the director-to-orchestrator and orchestrator-to-worker routes with the other seated roles.
3. Spawn and bind the orchestrator for this director seat before delegating work.

## Silence is a defect signal

Follow the canonical [silence/watch rule](../rules.md#silence-is-a-defect-signal), upward and downward.
