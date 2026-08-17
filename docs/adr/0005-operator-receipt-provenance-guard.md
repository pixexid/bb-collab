# ADR 0005: Contract v19 — operator-receipt provenance guard

Status: in flight. Implements GH-133.

## Decision

Contract v19/schema v12 adds `operator_receipts.issuance_provenance`. The
console mint path writes `console`; the validated authorized-approver path
writes `attestation`. Historical receipt rows are dead letter: no historical
receipt row is modified. NULL or unknown provenance refuses; provenance is
never inferred from `approver_id`, digest shape, or memory.

`config_revision` retains the exact actor-to-this-operator-receipt binding and
the existing retirement condition. The guard drops only the prior
attestation-only provenance demand. Console and attestation rows must each
match their persisted provenance columns; attestation rows retain registry
validation. The request digest remains head-independent, so a rebase changes
only the separately exact-bound `candidate_head` field.

The four cached consumers must reread v19 or refuse stale-v18 provenance;
expected, attempted, and verified are all four. Only a persisted v19 4/4/4
rollout receipt is current. The fixture-only apply seam remains for existing
fixture tests; the v19 provenance tests use production RPC paths.

## Ordering rationale

The rollout chain is mandatory: v18 -> v19 -> v20. A merge can appear green
while the later v19 rollout receipt still fails; a forked v20 chain would then
advance from an unproven v19 consumer state. Merge v19, verify its required
rollout receipt, then begin v20. No operator request, receipt, apply, or other
live authority action precedes that merge, reload verification, and derivation
of `candidateHead` from post-merge main.
