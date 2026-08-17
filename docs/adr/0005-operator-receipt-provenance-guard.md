# ADR 0005: Contract v20 — consumed operator-receipt replay

Status: in flight. Implements GH-133.

## Decision

Contract v19/schema v12 added `operator_receipts.issuance_provenance`: the
console mint path writes `console` and the validated authorized-approver path
writes `attestation`. Contract v20/schema v12 repairs replay of a receipt that
was validly consumed before this marker existed. Historical receipt rows remain
dead letter: no historical receipt row is modified or backfilled. Provenance is
never inferred from `approver_id`, digest shape, or memory.

`config_revision` retains the exact actor-to-this-operator-receipt binding and
the existing retirement condition. Console and attestation rows must each match
their persisted provenance columns; attestation rows retain registry validation.
A new apply with NULL or unknown provenance refuses before any write. Only when
the mutation receipt proves the same request, receipt ID, candidate head,
idempotency key, and request digest already committed may replay return its
stored outcome without revalidating the consumed receipt provenance. Replay also
rechecks the receipt binding digest, receipt identity digest, consumed event,
and referenced StateEvent receipt and actor links; the actor remains bound to
this exact receipt. The request
digest remains head-independent, so a rebase changes only the separately
exact-bound `candidate_head` field.

The four cached consumers must reread v20: RPC doctor, CLI doctor, consumed
legacy replay (`OK` with the recorded outcome), and fresh NULL-provenance apply
(`OPERATOR_RECEIPT_INVALID`). Expected, attempted, and verified are all four.
A v19 receipt is unknown and is never migrated. Only a persisted v20 4/4/4
rollout receipt is current. The replay consumer requires a read-only observed
legacy receipt/mutation receipt/StateEvent chain and otherwise refuses instead
of synthesizing rollout success. The fixture-only apply seam remains for existing
fixture tests; the v20 provenance tests use production RPC paths.

## Ordering rationale

The rollout chain is mandatory: v18 -> v19 -> v20. A merge can appear green
while a later rollout receipt still fails; advancing v20 without the v19
premise would fork the consumer chain. No operator request, receipt, apply, or
other live authority action precedes the fix merge, reload verification, and
derivation of `candidateHead` from post-merge main.
