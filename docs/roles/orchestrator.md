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

## Independent review acceptance

For Tier-A, dispatch read-only and accept only through the [canonical gate](../operations-model.md#provisional-tier-a-verdict-acceptance): output is `PROVISIONAL` until exact completed+idle native profile proof. Requested routing never substitutes. `UNKNOWN` gets one exact post-idle retry; replace once, then block a second failure.

## Live state

Live state is never this page. Query the plugin database’s `role_generation_heads` joined to `role_generations` for current director, orchestrator, and worker records. Resolve the predecessor handoff from the returned thread’s thread storage; never write current seat IDs into documentation.

## First actions

1. Read the predecessor handoff file and compare its claims with the live queries.
2. Confirm the director-to-orchestrator and orchestrator-to-worker routes with the director and workers.
3. Establish the current lane owners before sending a frozen work order.

## Silence is a defect signal

Use the canonical [waiting-subscription rule](../rules.md#waiting-is-a-subscription).
