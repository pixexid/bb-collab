# ADR 0006: Contract v20 — exact role-event identity

Status: in flight. Implements GH-137; correlation pagination amended by GH-138 instance 3.

## Decision

Role qualification and succession read the cited request and completion from
the sanctioned BB event API by exact identity: `afterSeq = eventSeq - 1`,
`limit = 1`, exactly one returned event, then exact ID and sequence equality.
They page the ordered correlation after the request at 256 rows, advancing by
the last returned sequence until the exact cited completion appears, the read
passes its sequence, or a short page proves it absent. The page size is not a
per-turn limit. Total work is limited to 2,048 returned correlation events
(eight pages): the measured 328-turn sample had a 1,314-event maximum, so the
ceiling covers that maximum with 734 events (56%) of headroom. A real turn
exceeding the ceiling refuses `EXECUTION_COMPLETION_AMBIGUOUS`; it is never
accepted from a truncated prefix. The holder's earlier history is never read.

Exact thread, project, environment, source, host, request/completion identity,
witness, visibility, and holder-state refusals run before correlation paging.
They do not depend on the correlation window, so a citation failing one of
those checks performs no page read. Only accepted/start/completion linkage and
fallback checks depend on the correlated events. Request profile
completeness, completion status, and host-permission compatibility remain after
the atomic read to preserve their existing refusal ordering behind correlation
ambiguity; moving those checks would change which refusal wins when both facts
are invalid.

The completeness invariant is atomic event linkage across every page: the
sanctioned reader's full ordered correlation after the exact request must
contain one request-correlated accepted event, one provider-correlated start,
and the exact cited completion, with no fallback. The exact completion
terminates the accepted prefix. A missing termination, non-strict local order,
or ambiguous linkage refuses `EXECUTION_COMPLETION_AMBIGUOUS` before a
canonical write. A page-read failure exposes no partial reader and retains the
existing unavailable-context refusal. Exact identity, profile, completion
status, fallback, thread, project, environment, source, host, witness,
hidden-thread, and foreign-context checks remain fail closed. The director
generation-1 exemption is unchanged.

This trades away dense sequence coverage. The resolver neither guarantees
that every integer sequence exists nor infers an event from an absent sequence
value. It accepts the linked facts actually returned by the sanctioned reader
as the native trust boundary; a reader that hides native events would be a
separate trust-boundary defect, not evidence recoverable through sequence
arithmetic. The former whole-history ordering sweep and length-equals-sequence-
width invariant are therefore explicitly removed rather than retained as
implicit requirements. Sparse native sequence space is normal.

Long cited turns require more pages, not a different cited turn. No thread is
compacted or manipulated to satisfy the reader.

## Live evidence methodology

Read-only measurement compared the plugin's sanctioned SDK event route with
the bounded/full `bb thread log` surface using pagination, preserving deltas
and `thread/compacted` rows. At one stable comparison snapshot both surfaces
returned the same 16,107 `(sequence, event ID, type)` tuples over sequence
range 1..140,494 with an exact tuple hash match. Thus the missing sequence
values are native non-contiguous assignments or genuine absences, not CLI
filtering relative to the SDK. Four returned `thread/compacted` events were
observed but are not treated as a sparsity cause. Later acceptance snapshots
are measured directly from the SDK surface and state their own counts. On the
amended candidate, that surface returned 18,428 events over sequence range
1..165,936 (present/width density 0.1111). Exact resolution passed for the
latest eligible turn (7 actual interior events) and a substantive busy turn
(252 actual interior events); each production read used two exact one-row
identity reads plus 256-row correlation pages, independent of the seat's total
history. Neither live run crossed a page boundary. The multi-page path is
covered by deterministic harness tests, including the sanctioned SDK adapter,
exact page boundaries, ceiling exhaustion, missing completion, and atomic
partial-window refusal. The opt-in live-shape test is skipped by `npm run
verify` unless `BB_LIVE_ROLE_CONTEXT=1` is explicitly supplied.

Densities carry the argument; absolute counts are snapshots.

## Ordering rationale

The rollout chain is mandatory: v18 -> v19 -> v20. A merge can appear green
while a later rollout receipt still fails; advancing v20 without the v19
premise would fork the consumer chain. This ADR is numbered 0006 because ADR
0004 and ADR 0005 landed first. This redesign repairs the existing v20
implementation's read plumbing without changing its cited identity or linkage
obligations, so it does not change `CONTRACT_VERSION`, schema, or either digest.
No live install, reload, receipt, apply, SQLite, or canonical mutation is part
of this implementation.
