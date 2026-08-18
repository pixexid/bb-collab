# bb-collab

## What this is

This repository is bb-collab's source and documentation.
The plugin is the local collaboration surface; its store is the canonical work-state location.
The fleet is a director, an orchestrator, and workers using BB-native threads and environments.

## Contract

`CONTRACT_VERSION: 25` — apply the [version-bump test](docs/rules.md#version-bump-test) before changing it.

## Reading order for a fresh seat

1. Read your [role page](docs/roles/) first; it gives your authority, live-state locations, and first actions.
2. Read the [operations model](docs/operations-model.md) for the role matrix and review tiers.
3. Read [Ponytail](docs/ponytail.md) before choosing an implementation shape.
4. Read the [working rules](docs/rules.md) before coordinating, reviewing, or making a decision.
5. Read the [threat model](docs/threat-model.md) before touching a trust boundary.
6. Read the [README](README.md) for implemented internals; read ADRs only when changing their subject.

## Operator

- A worker hands a blocked decision to its orchestrator; an orchestrator hands an out-of-authority decision to its director.
- The director approves within its class, tells the operator what was approved and why, and binds its orchestrator on succession.
- Only credentials or accounts, real spend, legal matters, product direction, and destructive-irreversible actions go to the operator as plain questions.
- The operator's typed reply settles an operator-only question; otherwise the director's approval is the operating decision.
- Workers never ask the operator orientation questions.

## Rules

- [Decision hierarchy](docs/roles/director.md#authority) — approval is a message from the tier that owns the decision.
- [One review pass per PR](docs/rules.md#one-review-pass-per-pr) — one independent review, then the orchestrator verifies the fixed head and merges.
- [Proof must discriminate](docs/rules.md#proof-must-discriminate) — evidence must fail when the claimed property is false.
- [Canonical source, no restated copies](docs/rules.md#canonical-source-no-restated-copies) — point to the definition or query, never cache its value.
- [Version-bump test](docs/rules.md#version-bump-test) — bump only for a changed running-session obligation.
- [Question is not delegation](docs/rules.md#question-is-not-delegation) — keep questions and frozen work orders separate.
- [Delegation return path](docs/rules.md#delegation-return-path) — every delegation says where DONE, BLOCKED, or WAITING returns.
- [One writer per lane](docs/rules.md#one-writer-per-lane) — one branch and one owner per edit lane.
- [Quiet with startable work is a defect state](docs/rules.md#quiet-with-startable-work-is-a-defect-state) — intake fires on every wake; the check is `startable > 0 AND lanes < cap`.
- [Blast radius](docs/rules.md#blast-radius) — update affected open artifacts with the decision that invalidates them.
