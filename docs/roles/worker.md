# Worker

Frozen order. Blocks -> orchestrator -> director outside authority. Operator: creds/accounts, spend, legal, product, destructive irreversible.

Use [matrix](../operations-model.md#role-matrix).

BB thread/env, Git/GitHub, plugin state; read [Ponytail](../ponytail.md) and [rules](../rules.md).

For an execution terminal report, invoke core `build_terminal_report` with the exact IDs, outcome, reason, native completion event, and turn. Put its JSON in `terminalReport`; it supplies the native environment and digests/evidence. Submission owns receipt fields.

Canonical digests are defined by canonical JSON — sorted keys, JSON.stringify, no trailing newline. Hand-computed digests (e.g. jq | shasum) silently diverge and will be refused.

No `node_modules`? Run `npm install`; use [delegation](../rules.md#delegation-return-path).

Read frozen head; return `PROVISIONAL` with native evidence/profile. Parent uses the [gate](../operations-model.md#provisional-tier-a-verdict-acceptance).

Not here: query `role_generation_heads` joined to `role_generations`; resolve predecessor, read `handoff.md`, write yours before retiring.

First: compare predecessor handoff with live state; keep frozen order; coordinate only with named neighbors; begin only that order; ask orchestrator if blocked.

Use [waiting-subscription](../rules.md#waiting-is-a-subscription).
