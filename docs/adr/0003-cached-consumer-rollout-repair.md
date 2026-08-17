# ADR 0003: Contract v18 — cached-consumer rollout repair

Status: accepted. Implements GH-122 corrective direction of 2026-08-16.

Superseded by [ADR 0007](0007-v21-authority-ceremony-removal.md), which
removes the receipt-based cached-consumer machinery this ADR records.

## Decision

Contract v18 preserves the v17 director/orchestrator policy and schema v11.
It corrects only the cached-consumer rollout mechanism. The four consumers are
the registered production RPC `doctor` handler, CLI `doctor` dispatcher, and
two separately named production live-project stale-policy clone validations.
All four must reread v18; both stale-v17 clones must refuse with
`INVALID_INPUT`; expected, attempted, and verified are each 4.

The durable artifact is `cached-consumer-v18-rollout-receipt`. It is accepted
only through the running `dist/server.js` rollout caller and the existing
receipt-gated `decision_disposition` path. Doctor treats that v18 artifact as
the only current rollout evidence. Missing or v17 evidence is unknown and
fail-closed. No receipt migration, seeding, or canonical write is introduced.

## Consequences

The receipt can be produced only after v18 dist is live through a reloaded
plugin under the same provenance. Self-gating is acceptable exactly once:
without that correction, a v18 receipt cannot exist. The gate closes only when
doctor reports 4/4/4 VERIFIED from LIVE STATE; merge, suite, and review do not
close it.
