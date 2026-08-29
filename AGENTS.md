# bb-collab

## What this is

This repository is bb-collab's source and documentation.
The plugin is the local collaboration surface; its store is the canonical work-state location.
The fleet is a director, an orchestrator, and workers using BB-native threads and environments.

## Contract

`INSTRUCTION_CONTRACT_VERSION: 51` — this is the instruction contract for agent sessions; apply the [instruction-contract version-bump test](docs/rules.md#version-bump-test) before changing it. The separate canonical `RUNTIME_CONTRACT_VERSION` lives in `src/foundation.ts` and feeds `contractDigest`.

## Reading order for a fresh seat

1. Read your [role page](docs/roles/) first; it gives your authority, live-state locations, and first actions.
2. Read the [operations model](docs/operations-model.md) for the role matrix and review tiers.
3. Read [Ponytail](docs/ponytail.md) before choosing an implementation shape.
4. Read the [working rules](docs/rules.md) before coordinating, reviewing, or making a decision.
5. Read the [threat model](docs/threat-model.md) before touching a trust boundary.
6. Read the [README](README.md) for implemented internals; read ADRs only when changing their subject.

## Before pushing

After committing, run the composed-PR gate against the full range it derives from `origin/main..HEAD`:

```sh
env -u BB_CLI node scripts/check-composed-pr.mjs \
  --title <title> --body-file <path> --file <each changed path>
```

Run this only after committing because it derives commit messages from `origin/main..HEAD`. The `--commit-message` and `--base` options no longer exist, so do not add them. Pair a pass with a rejection: run the same command once with a deliberately invalid PR body, confirm it fails, then run it with the real body and require the pass. Commit messages may omit issue linkage. If one contains a linkage mention, only close/fix/resolve forms are accepted, and only when they target the PR's `Closes #NN` issue. Every other linkage form fails. Keep the disposition line in the PR body only.

A fresh worktree may have no dependencies. `npm ci` is expected before verification; “do not deploy, reload, or install” applies to PLUGIN operations, not npm.

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
- [A work order owns bounds, not method](docs/rules.md#a-work-order-owns-bounds-not-method) — authors set coordination constraints; lanes choose implementation from code evidence.
- [One writer per lane](docs/rules.md#one-writer-per-lane) — one branch and one owner per edit lane.
- [Quiet with startable work is a defect state](docs/rules.md#quiet-with-startable-work-is-a-defect-state) — intake fires on every wake; the check is `startable > 0 AND lanes < cap`.
- [Blast radius](docs/rules.md#blast-radius) — update affected open artifacts with the decision that invalidates them.
- [External-party content uses the inbox](docs/rules.md#external-party-content-uses-the-inbox) — actionable operator content outside the current conversation goes through the inbox once available.
- [Project-agnostic by construction](docs/rules.md#project-agnostic-by-construction) — changed project-owned behavior requires an explicit exact `project_id`.
- Interrupted attempts are first-class debt: native interruption without accepted correlated terminal evidence is never `done`, never fires dependents, and requires explicit resume or disposition.
- When an exact owner completed naturally but lacks `build_terminal_report`, the current director or project-orchestrator uses `consume_execution_attempt_completion`; never re-wake the owner, hand-build evidence, or destroy a healthy environment to reach the stranded-failure seam.
