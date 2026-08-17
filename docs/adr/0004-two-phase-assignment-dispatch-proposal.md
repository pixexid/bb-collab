# ADR 0004: two-phase assignment dispatch and reconcile (adopted direction)

- Status: adopted direction — Option A adopted; Option B declined
- Date: 2026-08-16
- Scope: `assignment_dispatch`/`assignment_reconcile` contract amendment options
- Authority: operator adjudication gate recorded; implementation remains gated (see section 8)
- Linked issue: [GH-104](https://github.com/pixexid/bb-collab/issues/104)

Superseded by [ADR 0007](0007-v21-authority-ceremony-removal.md) for this
proposal’s removed receipt and approval machinery. It remains historical.

## 1. Decision direction (Option A adopted; Option B declined)

This ADR records Option A as the adopted direction for a future two-phase
amendment to the canonical `assignment_dispatch` and `assignment_reconcile`
mutation contract. Option B is declined because it places native effect before
canonical authorization and leaves orphan and authorization-gap exposure.
Implementation is not adopted by this document.

Nothing in this document changes `CONTRACT_VERSION` (15), `SCHEMA_VERSION`
(11), any migration, the resolver, adapter code, `dist`, the live plugin or
runtime, SQLite, receipts, credentials, or any canonical state. The current
`OPERATOR_RECEIPT_TWO_PHASE_UNSUPPORTED` refusal remains fully in force.
Implementing the adopted direction requires a separately reviewed Tier-A lane that
performs the cached-consumer bump test, emits rollout/refusal receipts, and
carries its own adopted disposition; see section 7.

Two candidate shapes are compared:

- **Option A — reserve-with-receipt plus asynchronous finalize.** Canonical
  authorization and a durable reservation are committed first under an
  operator-confirmed reserve receipt; the native spawn happens asynchronously
  under plugin control outside `apply`; a second finalize receipt commits the
  native evidence or records `DISPATCH_UNKNOWN`.
- **Option B — record-after-the-fact reconciliation.** The plugin spawns
  first through the async BB SDK, then correlates and records the native
  execution against a prepared Assignment in one post-hoc canonical mutation.

Option A preserves the founding invariant that canonical authorization
precedes native effect. Option B inverts it and inherits orphan and
authorization-gap exposure. The recorded direction therefore adopts Option A
and declines Option B; implementation remains subject to the gates below.

## 2. Problem and proven evidence

All citations are against base head
`cab6c7ab74422ed42b8ec40521e50eb562be861f` (`origin/main` at proposal time).

### 2.1 Zero canonical assignments despite the profile-audit release

GH-104 ("Assignment/ExecutionAttempt recording gap blocks profile compliance
audit") is OPEN. The canonical assignment profile audit shipped in merged
commit `3d05093` ("Add canonical assignment profile audit") and is documented
in [the GH-104 audit note](../issue-104-assignment-profile-audit.md): the
doctor exposes `profileAudit` from canonical Assignment/ExecutionAttempt rows
and reports `no_canonical_assignments` when zero rows exist
(`src/foundation.ts`, doctor `profileAudit` status). Through the sanctioned
seams the canonical assignment tables cannot grow: live `apply` wires no
native assignment adapter (`server.ts`), so `assignment_prepare` refuses
`BB_FACTS_UNAVAILABLE` in production, and `assignment_dispatch`/
`assignment_reconcile` are refused by the receipt gate before any adapter.
The audit release therefore
cannot produce compliance evidence — the fail-closed design is working as
intended, but the recording seam it audits is unreachable from live
authority. The audit note itself states the boundary: "A live BB spawn
inventory remains outside this plugin until a sanctioned native adapter is
wired by a separately bounded change."

### 2.2 Async BB SDK versus the synchronous adapter/resolver seam

The `NativeAssignmentAdapter` interface is synchronous by construction
(`src/foundation.ts:1608-1612`): `inspect`, `dispatch`, and `reconcile`
return `NativeAssignmentInspection`/`NativeAssignmentEvidence` objects, not
promises. The resolver functions that call it (`applyAssignmentNative` and
its transactional helpers) are synchronous. The BB plugin SDK surface is
asynchronous: the live RPC entry is `async apply(input)` in `server.ts`, and
every native fact source (`bb.sdk` threads, events, environments, projects,
hosts, versions) is awaited.

The live wiring makes the mismatch moot today: `applyLiveAuthorizedMutation`
(`server.ts:471-476`) calls `applyAuthorizedMutation(db, input, null, reader)`
— no `nativeAssignmentAdapter` argument at all, so the parameter defaults to
`null`. Even if the receipt gate admitted dispatch, `applyAssignmentNative`
would return `DISPATCH_UNKNOWN` with "native assignment adapter is
unavailable". There is no production adapter; only fixture adapters exist
(`src/test-support.ts`) on the fixture-only `applyFixtureMutation` path. An
async BB SDK adapter cannot be bound to the synchronous seam without
changing either the seam or the calling protocol — that is exactly the
contract amendment this ADR scopes.

### 2.3 The intentional two-phase refusal

Production `apply` refuses before any adapter call
(`src/foundation.ts:7794-7798`): `github_issue_projection`,
`assignment_dispatch`, and `assignment_reconcile` return
`OPERATOR_RECEIPT_TWO_PHASE_UNSUPPORTED` ("one-request operator receipts do
not authorize reserve/finalize adapter operations") even when a valid,
exactly bound, unconsumed one-request operator receipt is presented. This is
proven by `tests/server.test.ts` (dispatch and reconcile refusal with a real
receipt plus a working adapter, and the same refusal for the projection
class).

The refusal is deliberate, not an omission. The interim operator receipt is a
one-request grant: exact project, operation class, candidate head,
idempotency key, and normalized request digest, consumed by atomic
compare-and-set with the first StateEvent, with no local expiry or
revocation and retirement only on the host-issued `get-bb/bb#1541`
condition. [The threat model](../threat-model.md) explicitly lists "interim
receipt replay or phase splitting — one receipt authorizes a second mutation
or a reserve/finalize adapter sequence" as a defended vector. A dispatch
whose adapter call straddles the transaction boundary (claim committed, then
native call, then evidence commit) is a two-request shape at the authority
layer, so the one-request receipt cannot honestly cover it. Any amendment
must therefore authorize each phase with its own exactly bound, atomically
consumed one-request receipt rather than stretching one receipt across two.

### 2.4 What already exists and must not be duplicated

Inside the fixture-only path, the full reserve/claim/finalize machinery
already exists and is the natural substrate for Option A:

- `assignment_prepare` is admitted by the one-request receipt gate in
  production, but it is not executable live: `applyAssignmentMutation`
  requires a native adapter for its `inspect` facts and refuses
  `BB_FACTS_UNAVAILABLE` when none is wired (`server.ts` live apply passes
  no adapter), so adoption scope must include live inspection wiring. It
  stores the immutable Assignment intent and creates the prepared
  ExecutionAttempt.
- Dispatch requires attempt state `prepared`; it performs a native-evidence
  compare-and-swap from `prepared` to `dispatch_unknown` with reason
  `dispatch_claimed`, commits an `assignment_dispatch_claimed` StateEvent
  under a derived claim idempotency key, then calls the adapter outside the
  transaction, then records native evidence through a second native-evidence
  compare-and-swap committing `assignment_content_delivered`,
  `assignment_dispatch_failed`, or `assignment_dispatch_unknown`.
- An adapter throw becomes `ambiguous`/`native_transport_ambiguous`; a crash
  after a possible native effect leaves the durable `dispatch_unknown` claim
  ("native effect may have occurred; durable dispatch claim remains
  unresolved").
- Reconcile accepts only an attempt in `dispatch_unknown` and merges
  correlated native evidence.

The amendment question is not how to build the two-phase flow — it exists —
but how to authorize and schedule it in production under async native
transport without weakening receipts or actors.

## 3. Constraints any amendment must satisfy

1. Each canonical mutation remains exactly one operator-confirmed,
   exactly bound, atomically consumed one-request receipt; replay returns
   the original committed receipt byte-for-byte; conflicting reuse refuses.
   No receipt may authorize a second mutation.
2. The derived plugin actor, its `operator_receipt_id` link, the
   authorized-approver registry, and the ten-class derived allowlist are not
   weakened. If assignment phase classes join an actor allowlist, that is a
   reviewed class-set change with its own refusal tests, not a silent edit.
3. Requested profile fields are never copied into executed evidence; only
   BB-native identity, event, and provider-receipt facts may populate
   `ExecutionAttempt` actuals, through the existing native-evidence
   compare-and-swap discipline.
4. Canonical authorization (role head, qualification, lane ownership,
   governance epoch/fence, config revision, aggregate revision) is validated
   inside the same bounded transaction that commits the phase's StateEvent.
5. `DISPATCH_UNKNOWN` remains the only honest response to an ambiguous
   native effect; there is no blind retry; recovery is reconcile-only.
6. The schema's `operator_receipts.mutation_class` CHECK constraint already
   admits all sixteen canonical classes, so class reuse is possible without
   DDL; adding new class names requires a table-rebuild migration and a
   schema bump.
7. No second authority store, no watcher fleet, no raw SQL path, and no
   production use of `applyFixtureMutation` or fixture adapters.

## 4. Option A — reserve-with-receipt plus asynchronous finalize

### 4.1 Shape

Phase 1, `assignment_dispatch` (reserve). The operator confirms a one-request
receipt bound to project, operation class, the exact assignment and
execution-attempt identity, the candidate head, idempotency key, and the
normalized reserve request digest. Inside one bounded transaction the
resolver revalidates authority (role head and holder binding, qualification,
lane ownership, governance epoch/fencing token, config revision, aggregate
revision), performs the existing `prepared` → `dispatch_unknown`
compare-and-swap claim, and commits the `assignment_dispatch_claimed`
StateEvent and mutation receipt. Apply then returns a reservation receipt
naming the reserved attempt. No adapter is called inside apply; the native
spawn is not claimed to have happened.

Async gap. The plugin, outside `apply` and outside any canonical
transaction, performs the BB SDK spawn (or attach) for the reserved attempt
using the frozen brief and requested profile, and collects native
correlation facts: BB server id, thread and provider-thread ids, native
request id, request/accepted/first-action/content event ids and sequences,
last event sequence, and the actual profile from provider/BB receipts. This
is where the async SDK lives: the adapter seam becomes an async,
plugin-owned boundary that feeds phase 2, while each phase's canonical
mutation stays the existing synchronous, transactional resolver shape.

Phase 2, finalize (either a new `assignment_dispatch_finalize` class or the
existing `assignment_dispatch` class with a phase discriminator carried
inside the request digest — a choice for the adoption lane, since the first
form costs a schema migration and the second costs only a contract bump).
A second operator-confirmed one-request receipt, cross-bound to the
reservation by including the reservation identity and the reserved attempt's
native-evidence column snapshot in its request digest, authorizes exactly
one finalize. The resolver revalidates authority again against the current
head, then either:

- commits correlated native evidence through the existing native-evidence
  compare-and-swap (`assignment_content_delivered` or
  `assignment_dispatch_failed`), or
- records `assignment_dispatch_unknown` when the native transport stayed
  ambiguous, leaving the durable claim for `assignment_reconcile`.

### 4.2 Binding, idempotence, timeout, crash recovery

The async gap is where this option earns or loses its Tier-A claim, so its
authority and crash semantics are stated as amendment requirements, not
implementations:

- Receipt binding: two receipts, each one-request, each atomically consumed;
  the finalize digest names the reserve receipt id, reservation attempt, and
  the exact evidence-column snapshot it supersedes, so a finalize cannot be
  replayed against different evidence or a different reservation.
- Replay: byte-for-byte idempotent return of the original committed receipt
  per phase; the existing derived claim idempotency key
  (`assignment-dispatch-claim-…`) already prevents double claims.
- Authority validity across the gap is bounded, not absolute. Before the
  native send, the async spawn boundary must itself revalidate that the
  reservation is still current — role head, lane ownership, governance
  epoch/token, config revision unchanged, and the attempt still exactly the
  reserved `dispatch_unknown` claim snapshot — and must abort with no native
  effect if anything moved. Because a revalidation and an asynchronous send
  cannot be one atomic act, a residual race window remains, and the adoption
  lane must fence it by one of two explicitly costed choices: (i)
  serialization — every authority input that finalize and reconcile
  revalidate (role succession, config revision, governor epoch, WorkItem
  transitions touching the reserved WorkItem, and the qualification/
  eligibility state bound to the assignment's role requirement, since a
  later qualification observation or eligibility expiry can invalidate the
  reservation without moving any of the other heads) is refused from
  changing while any unresolved reservation exists — the adoption lane must
  enumerate the full closure of revalidated inputs rather than a
  hand-picked list; or (ii) a send-claim
  compare-and-swap from `dispatch_unknown` to a new `sending` state carrying
  the native idempotency identity — which is a third canonical mutation, so
  under this contract it requires its own exactly bound one-request operator
  receipt plus a schema migration extending the execution-attempt state
  CHECK, both of which must be counted in the adoption lane's bump test.
  Neither choice makes pre-send revalidation absolutely sufficient; each
  only narrows the race, and the residual window is closed by evidence, not
  state (see crash recovery). This proposal requires the choice to be made
  and proven; it does not presume (ii) silently.
- Stale-head evidence recovery is an explicitly open design decision, not an
  automatic property. Finalize and reconcile both revalidate against the
  current head exactly as today: the assignment's original config revision,
  governance epoch and role generation must remain current. If any head
  moves while a reservation is unresolved, evidence recording refuses, and
  recovery is not automatic. The adoption lane must choose and prove one
  of: (a) blocking the full revalidated-input closure (see fencing choice
  (i)) while any unresolved reservation exists — a dispatch-intent freeze;
  (b) an operator-adjudicated
  stale-evidence reconciliation path with its own receipt that records the
  attempt as historical evidence without granting it authority, or (c) a
  bounded reservation lifetime that bounds the exposure window — noting
  that (c) alone is not a recovery path, since expiry does not make
  post-send evidence recordable after heads have moved, so (c) may only
  combine with (a) or (b). This proposal does not choose among them.
- At-most-once send is a hard requirement, not an implication. The native
  request must carry a BB-native idempotency identity derived from the
  reservation (the claim identity), and recovery must distinguish the two
  crash windows: a crash before the send leaves the reservation abortable
  with no native effect, while a crash after the send is reconciled through
  that native identity. The existing claim key prevents duplicate claims; it
  does not by itself prevent duplicate asynchronous sends, so the adoption
  lane must prove the native idempotency binding before any live
  enablement.
- Retry: no blind retry ever. An ambiguous spawn leaves
  `DISPATCH_UNKNOWN`; the only forward path is `assignment_reconcile` with
  its own receipt and correlated native facts.
- Timeout: receipts have no local expiry by contract. Reservation staleness
  is instead authority staleness: the pre-send revalidation and finalize both
  revalidate the current head, and a reserved attempt whose
  assignment/config/governor head moved refuses (`ASSIGNMENT_HEAD_STALE`
  and friends) exactly as today.
- Crash recovery: no crash window can be resolved by local state alone,
  because a crash between deciding to send and the SDK acknowledging the
  send is fundamentally indistinguishable from an attempted send. The only
  authoritative negative evidence is native: recovery for every pre-effect
  window is a reconcile-style native lookup proving the reservation's
  native idempotency identity was never instantiated (no thread and no
  native request id exists for it), and a local abort/cancel transition may
  fire only on that proof — under fencing choice (ii) the send-claim CAS
  additionally bounds which reservations need the lookup, but its own
  post-CAS/pre-SDK-acknowledgement crash window still resolves the same
  way. Without that native proof, an unresolved reservation is treated as
  after-send and falls to reconcile or the open stale-evidence disposition.
  Crash after send but before finalize leaves a durable `dispatch_unknown`
  claim with a known native idempotency identity, readable by doctor and
  recoverable by reconcile while the assignment's original heads remain
  current; crash mid-finalize either committed the evidence transaction or
  did not, and replay of the finalize receipt returns the original outcome.

### 4.3 Refusal modes (additive, all typed)

| Condition | Typed result |
| --- | --- |
| Reserve receipt missing, stale, reused, or misbound | existing `OPERATOR_RECEIPT_*` refusals |
| Attempt not `prepared`, or claim CAS lost | `ASSIGNMENT_HEAD_STALE` / `DISPATCH_UNKNOWN` |
| Finalize receipt not bound to the live reservation | `OPERATOR_RECEIPT_STALE` (exact-binding mismatch) |
| Finalize evidence fails correlation (missing native ids, non-monotonic events, future timestamps) | `DISPATCH_UNKNOWN` (claim retained; reconcile-only) |
| Authority head moved between phases | `ASSIGNMENT_HEAD_STALE`, `GOVERNOR_EPOCH_STALE`, `PROJECT_CONFIG_STALE`; evidence stranded pending the open stale-evidence disposition |
| Actual profile unknown at finalize | evidence recorded unknown; attempt ineligible for role/gate use |

### 4.4 Assessment

Option A keeps authorization before effect, reuses proven machinery, and
localizes the new surface to: two-receipt cross-binding, the async adapter
wiring at the plugin boundary, and the finalize class naming. It is the
adopted direction.

## 5. Option B — record-after-the-fact reconciliation

### 5.1 Shape

Option B presupposes the existing operator-receipted `assignment_prepare`,
which already validates role, qualification, lane, and capacity controls and
creates the immutable Assignment plus its prepared ExecutionAttempt rows.
The plugin then spawns through the async BB SDK without any canonical
dispatch reservation, and performs one further operator-receipted post-hoc
record — either the existing `assignment_reconcile` semantics or a sibling
record class — that correlates the spawned thread's native identity, events,
and actual profile to that prepared attempt in a single transaction.

### 5.2 Risks and required dispositions

- Orphan risk: if correlation fails, is refused, or is never submitted, the
  canonical rows exist but no reserved claim binds the spawn to them, so the
  live thread's activity is unattributable to any ExecutionAttempt. ADR 0001
  documents this as the unmanaged-activity enforcement ceiling (raw BB
  activity cannot be physically vetoed); `UNMANAGED_ACTIVITY` is a documented
  ADR 0001 outcome, not an implemented `FoundationCode` today, so Option B's
  adoption would have to add that typed outcome or fall to read-only orphan
  reporting plus operator discard/adopt. Either way the orphan may already
  have written to the repository target; nothing in the canonical store
  prevented it.
- Authorization gap (time-of-check to time-of-effect): prepare validates
  role, qualification, lane, and capacity, but nothing revalidates them when
  the native spawn actually starts — there is no reservation to revalidate
  against. Between prepare and spawn, role heads, config, governance, or
  lane ownership can move, and whatever prepare-time checks held cannot
  refuse the spend or the write the unreserved spawn performs de facto. The
  defect is the missing dispatch-time revalidation, not the absence of all
  pre-effect authorization.
- Replay and idempotence: the record must be idempotent by native
  correlation identity (thread/request/event ids), and the disposition for
  a duplicate late record must be a typed refusal keyed to that identity
  (extending existing `IDEMPOTENCY_KEY_CONFLICT` semantics to the
  correlation key), not a silent overwrite; without that, a re-run
  duplicates attempts or refuses arbitrarily.
- Crash recovery: a crash between spawn and record is exactly the orphan
  case above, recoverable only by a later record or operator disposition —
  there is no canonical reservation to recover from, which is the point of
  contrast with Option A. A crash mid-record is a single transaction, so it
  commits wholly or not at all.
- Canonical-authority analysis: B makes the native spawn the primary act and
  the canonical store a post-hoc ledger of external effects. That inverts
  the founding boundary that projections and native facts are evidence for
  authority, never substitutes for it, and drifts toward a second de-facto
  authority (whatever BB actually allowed) that canonical state merely
  describes. The `LANE_WRITER_EXISTS` cap and governorship fencing also
  lose their pre-effect meaning.

### 5.3 Refusal modes

Existing role-context and dispatch refusals (`ROLE_CONTEXT_*`,
`DISPATCH_UNKNOWN`, `IDEMPOTENCY_KEY_CONFLICT`, `RESOURCE_REVISION_STALE`)
plus stale-authority refusals at record time; orphan handling would need
`UNMANAGED_ACTIVITY` added as a typed code or remain read-only reporting.
Every refusal lands after the native effect has already happened; that is
the defining defect.

## 6. Option comparison

| Dimension | A: reserve + async finalize | B: record after the fact |
| --- | --- | --- |
| Authorization precedes native effect | Yes, in the reserve transaction | Prepare-time only; no spawn-time revalidation |
| Orphan exposure | None from this seam; crash leaves a known reservation | Structural: refused/failed correlation leaves the spawn unattributable |
| Receipt integrity | Two one-request receipts, cross-bound, each atomic | One receipt, but only for a fait accompli |
| Reuse of proven machinery | Direct (existing claim/CAS/StateEvents) | Partial (reconcile half only) |
| Async SDK fit | Native (spawn lives in the gap between phases) | Native, but inverts authority order |
| New surface | Finalize class naming + cross-binding rules | Correlation-idempotence rules + orphan policy |
| Consistency with ADR 0001 | Full | Conflicts with the authority boundary |

## 7. Migration and cached-consumer impact

This proposal changes no version, digest, migration, receipt, or consumer.
`CONTRACT_VERSION` stays 15 and `SCHEMA_VERSION` stays 11 at this head; no
cached consumer observes any difference from this document.

Option A implementation would require: a `CONTRACT_VERSION` and `contractDigest`
bump; either a schema bump with a table-rebuild migration (new receipt class
names under the `operator_receipts.mutation_class` CHECK) or no DDL (reuse
with a digest-carried phase discriminator) — where no-DDL holds only under
fencing choice (i), since choice (ii) additionally requires the
execution-attempt state CHECK migration and its own third receipt, both
counted here; the full cached-consumer bump
test enumerating all four consumers with reread-or-refuse proof, expected/
attempted/verified counts, and durable rollout receipts; refusal tests for
stale-consumer versions; and its own adopted decision/disposition chain.
Option B, which is declined, would carry the same bump-test obligations with likely no DDL
but larger semantic refusal surface (orphan policy). The adopted direction
still requires the separately reviewed Tier-A implementation lane described
in section 1.

## 8. Operator adjudication gate

The direction decision is recorded: implement Option A; Option B is declined.
Only the operator, through a future separately reviewed Tier-A implementation
lane with its own ADR/dispositions, bump test, rollout receipts, and
confirmation interactions, may authorize implementation. Until that lane is
adopted and complete, the `OPERATOR_RECEIPT_TWO_PHASE_UNSUPPORTED` refusal is
the controlling behavior and must not be relaxed, bypassed, or feature-flagged.

## 9. Non-goals

- No bypass, feature flag, env var, or code path around the two-phase
  refusal outside an adopted amendment.
- No production use of `applyFixtureMutation`, fixture adapters, or any
  test-only seam; fixtures stay fixtures.
- No second authority store, mutable Markdown task database, watcher fleet,
  custom bus, or raw SQL authority path.
- No weakening of one-request receipt binding, atomic consumption,
  original-replay-only idempotency, derived-actor gates, approver registry
  bindings, or retirement conditions.
- No live install, reload, activation, SQLite mutation, or canonical state
  change from this document.

## 10. Evidence index

- `src/foundation.ts:8-9` — `CONTRACT_VERSION = 15`, `SCHEMA_VERSION = 11`.
- `src/foundation.ts:1608-1612` — synchronous `NativeAssignmentAdapter`.
- `src/foundation.ts:7290-7382` — native-evidence compare-and-swap finalize
  (`recordNativeEvidence`).
- `src/foundation.ts:7383-7483` — fixture dispatch claim, adapter call,
  ambiguity handling (`applyAssignmentNative`).
- `src/foundation.ts:7794-7798` — production two-phase refusal before the
  adapter.
- `src/foundation.ts` doctor `profileAudit` — `no_canonical_assignments`
  when zero canonical assignment attempts exist.
- `src/foundation.ts` `operator_receipts` DDL — sixteen-class CHECK,
  one-request binding columns.
- `server.ts:471-476` — live apply passes no assignment adapter.
- `server.ts:1008-1010` — async RPC `apply`.
- `tests/server.test.ts:2647-2710` — proven refusal with valid receipt and
  working adapters.
- `docs/threat-model.md` (receipt replay/phase-splitting row) — defended
  vector behind the refusal.
- `docs/issue-104-assignment-profile-audit.md` — audit seam and its
  explicitly deferred live-adapter boundary.
- GH-104 issue state: OPEN at proposal time.
