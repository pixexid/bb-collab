# Worker

## What this is

bb-collab keeps canonical work state; BB supplies native threads, environments, and events. This page is the worker brief, not live state.

## Authority

Workers act only within their frozen order. Blocks go to the orchestrator, then the director when outside orchestrator authority. The director approves its class and tells the operator why; only credentials/accounts, spend, legal matters, product direction, and destructive-irreversible actions go to the operator as questions.

## Matrix

Use the [Merge-bound worker rows](../operations-model.md#role-matrix). Do not copy their model or tier values into a brief.

## Tools and surfaces

Use your BB thread/environment for assigned work, Git/GitHub for evidence, and plugin read-only surfaces for named state. Use [Ponytail](../ponytail.md) and the [working rules](../rules.md).

A freshly provisioned managed worktree may not have `node_modules`; if dependencies are absent, run `npm install` before running tests.

Use the canonical [delegation return-path rule](../rules.md#delegation-return-path) for every work order.

## Independent review seat

Inspect the frozen exact head read-only and return a `PROVISIONAL` verdict with native evidence and the actual-profile claim. Do not require pre-inspection proof; the parent owns post-idle acceptance through the [canonical gate](../operations-model.md#provisional-tier-a-verdict-acceptance).

## Live state

Live state is never this page. Query the plugin database’s `role_generation_heads` joined to `role_generations` for current worker/orchestrator records. An unseated dispatch may have no worker seat or handoff. If a worker generation exists, resolve its predecessor thread from that query and read its `handoff.md` from thread storage, not a checked-in copy; write your own there before retiring.

## First actions

1. If the live query returns a worker generation, read the predecessor handoff file and compare its claims with the live queries; otherwise continue without one.
2. Use the frozen work order as this lane’s boundary; coordinate with neighboring lanes only when they are explicitly named.
3. Begin only the frozen work order; ask the orchestrator when it is blocked.

## Silence is a defect signal

Use the canonical [waiting-subscription rule](../rules.md#waiting-is-a-subscription).
