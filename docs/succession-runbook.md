# Role generation creation and succession runbook

This is the operational runbook for the director/project-orchestrator seats of
any project governed by this plugin. Canonical authority remains the
actor-receipt-gated `role_generation_succession` resolver and its
`RoleGeneration` row. The operation class remains backward-compatible: null
expected and predecessor generations record **first-generation creation**;
exact non-null predecessor generations record **succession**. This document
is guidance, not a second role store.

This runbook is project-agnostic by construction. It names no project, thread,
environment, source, or digest. Read those from the canonical store at the
current config revision, never from documentation.

## Authorization

First-generation creation and succession are authorized by the operator's
typed word (ADR 0007). The
authority ceremony was deleted by operator ruling with no replacement: there
is no mint surface and there never will be one.

The apply gates on an **actor receipt** (`actor_receipts`), never an operator
receipt. `operator_receipts` is vestigial — the running resolver has no
operator-receipt read or write path. Cautionary, once: on 2026-08-19 the
fleet spent hours hunting an operator-receipt mint that the resolver never
required. Check which receipt class the code gates on before asking how to
mint one.

## Seat pairing and epoch naming

One epoch pairs one director generation with one orchestrator generation. The
incoming director runs the orchestrator's first-generation creation or
succession apply as appropriate. The mixed-epoch interval between the two
applies is a bounded transition state closed by the paired apply, never a
resting state.

Three sequences may coincidentally agree and must never be derived from one
another: the human-facing epoch in a seat's name, the canonical generation in
`role_generation_heads`, and `governance_epoch`. Report seats as name-epoch
plus canonical generation.

## Profiles and standby

Read each role's exact profile from its current canonical role requirement in
`project_config_revisions`, never from this document or from remembered
defaults. A profile change creates a new generation. Never mutate a live
authority thread's model in place.

Only director generations name one standby profile in
`RoleGeneration.standby_profile_json`, and its provider must differ from the
holder's executed provider; a same-provider or missing standby refuses before
any canonical write. `project-orchestrator` generations must omit a standby —
the resolver refuses one. A standby is not a role, actor, authority, lease,
assignment, dispatch target, or traffic recipient. If the standby is promoted
after a director failure, reverse the pair explicitly in the succession
request: the promoted former standby becomes the holder and the former
holder's profile becomes the standby.

Pre-existing records are retained as evidence; configuration and future
succession follow the current role requirement without inventing provider
evidence or rewriting historical generations.

## Triggers

For an unseated role, record first-generation creation. Start succession for
any of these conditions:

- context weight becomes costly (roughly 15–20 substantive turns or a
  disproportionate wake cost);
- provider death, quota exhaustion, mid-turn failure, or billing-cycle denial;
- provider, model, or reasoning profile change; or
- planned operator rotation.

## Procedure

0. Step zero: read the issue's own comments before dispatching against it.
   On 2026-08-19 the fleet dispatched a lane against work an operator ruling
   forbade because the dispatcher read the issue's title and not its
   comments.
1. Freeze new dispatches from the incumbent. In-flight assignments remain
   bound to their existing Assignment and ExecutionAttempt.
2. Check the handoff state and checksum against current canonical and native
   facts.
3. Prepare the successor with explicit provider, model, reasoning,
   permission, service-tier, and visibility values from the current canonical
   requirement. Do not rely on remembered defaults.
4. Bind the exact requested profile at dispatch and require the successor to
   attest its executed profile. Do not treat that attestation or the
   `client/turn/requested` event as authoritative readback; after-the-fact
   execution remains unknown until GH-215 and upstream get-bb/bb#1787 land.
   If promoting the director standby, reverse the pair as described under
   Profiles and standby, and confirm the standby provider differs from the
   holder provider before submitting the request.
5. Obtain a bounded comprehension acknowledgement (10 lines or fewer) naming
   the role, epoch, fleet state, next decision, and any contradiction found.
6. Submit the exact actor-receipt-gated `role_generation_succession` request.
   Null expected and predecessor generations must emit the canonical
   `role_generation_created` event; an exact non-null predecessor must emit
   `role_generation_succeeded`. The request wire remains the same for both
   meanings, and existing event history is never rewritten.
   Name the configured standby only for `director-seat`; omit it for every
   other role. The atomic `RoleGeneration` write is the authority transfer.
7. Consumers read the current `RoleGeneration` and its canonical event type;
   do not manually retarget watcher or escalation state.
8. Revoke the predecessor by record. A live predecessor may receive one
   retirement notice; a dead or quota-dead thread may reject tells, so do not
   wait for acknowledgement. Stale generations refuse further authority.
9. Do not archive the predecessor until its environment is proven disposable.

## Provider wrongful-idle or death response

For a provider death of the kind observed with `pi/kimi-coding/k3`, work may
have completed while the provider failed before reporting. `thread output`
can therefore show the previous clean result. Read the thread status and
native event log directly; `thread wait --status idle` exiting successfully
is not proof that the thread is healthy. If the Part 2 wrongful-idle detector
has delivered two ineffective steers, treat the condition as a succession
trigger and stop nagging the old thread.

For a director failure, prepare the configured standby through the same
procedure. For another role, prepare the successor from that role's exact
requirement; no standby is configured. The old generation is revoked by the
canonical record even when the dead thread cannot receive a tell.

## Audit traps

- Tells are not reliable evidence in thread history; inspect bounded native
  logs with an explicit limit and count `turn/started` events.
- Bind handoff and watcher stop conditions to the state change that the
  thread no longer holds the role, not to a ceremony name.
- The successor's first act is to re-check the handoff against live state;
  finding a real contradiction is a successful safety check.
