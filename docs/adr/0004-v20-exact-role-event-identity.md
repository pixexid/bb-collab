# ADR 0004: Contract v20 — exact role-event identity

Status: accepted. Implements GH-137.

## Decision

Role qualification and succession establish request and completion identity
with one sequence-addressed BB event read for each cited event. They then read
only the interior sequence slice, capped at the unchanged
`MAX_ROLE_CONTEXT_EVENTS = 256`, to preserve accepted/start/completion
correlation and model-fallback refusal. A long-lived holder's earlier events
are not enumerated. The cap is the monotonic span between cited event
sequences, not an event-count snapshot; no role-holder thread is compacted or
otherwise manipulated to satisfy it.

The old whole-log increasing-sequence sweep is not evidence available from
identity reads. It is removed as an implicit invariant. Inverted cited
sequences, a slice over the cap, a short slice, or locally unordered slice
evidence return `EXECUTION_COMPLETION_AMBIGUOUS` before a canonical write.
Mismatched cited identity/sequence also refuses closed. Thread, project,
environment, source, host, executed-profile, completion-status, witness, and
foreign-context checks are unchanged. The director first-generation exemption
constant is unchanged.

A later completion for the same provider thread is outside the cited bounded
turn and is not treated as a duplicate of the exact cited completion.

## Consequences

Contract v20 keeps schema v11 and replaces the v18 cached-consumer artifact
with `cached-consumer-v20-rollout-receipt`. Its four production consumers must
reread v20; a missing or v18 artifact remains unknown and fail-closed. No live
install, reload, receipt, apply, or canonical mutation is performed by this
implementation.
