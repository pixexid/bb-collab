# Role succession runbook

This is the operational runbook for the director/project-orchestrator seat.
Canonical authority remains the receipt-gated `role_generation_succession`
resolver and its `RoleGeneration` row. This document is guidance, not a
second role store.

## Standby

Every newly recorded `project-orchestrator` generation names one standby
profile in `RoleGeneration.standby_profile_json`. The ratified default name is
`luna/gpt-5.6-luna` (`providerId: luna`, `model: gpt-5.6-luna`, with explicit
reasoning, permission, service tier, and visibility). The standby provider
must differ from the holder's executed provider; a same-provider or missing
standby refuses before any canonical write. A standby is not a role, actor,
authority, lease, assignment, dispatch target, or traffic recipient.

Pre-existing generations may have no standby because the schema migration does
not invent provider evidence. Record the standby on the next canonical
succession, or use the normal receipt-gated succession path to replace the
generation.

## Triggers

Start succession for any of these conditions:

- context weight becomes costly (roughly 15–20 substantive turns or a
  disproportionate wake cost);
- provider death, quota exhaustion, mid-turn failure, or billing-cycle denial;
- provider, model, or reasoning profile change; or
- planned operator rotation.

A profile change creates a new generation. Never mutate a live authority
thread's model in place.

## Procedure

1. Freeze new dispatches from the incumbent. In-flight assignments remain
   bound to their existing Assignment and ExecutionAttempt.
2. Check the handoff state and checksum against current canonical and native
   facts.
3. Prepare the successor with explicit provider, model, reasoning,
   permission, service-tier, and visibility values. Do not rely on remembered
   defaults.
4. Verify the executed profile from native provider events, not spawn flags.
5. Obtain a bounded comprehension acknowledgement (10 lines or fewer) naming
   the role, epoch, fleet state, next decision, and any contradiction found.
6. Submit the exact receipt-gated `role_generation_succession` request with
   the named standby profile. The atomic `RoleGeneration` write is the
   authority transfer.
7. Consumers read the current `RoleGeneration`; do not manually retarget
   watcher or escalation state.
8. Revoke the predecessor by record. A live predecessor may receive one
   retirement notice; a dead or quota-dead thread may reject tells, so do not
   wait for acknowledgement. Stale generations refuse further authority.
9. Do not archive the predecessor until its environment is proven disposable.

## K3 wrongful-idle or death response

For a K3-like death, work may have completed while the provider failed before
reporting. `thread output` can therefore show the previous clean result. Read
the thread status and native event log directly; `thread wait --status idle`
exiting successfully is not proof that the thread is healthy. If the Part 2
wrongful-idle detector has delivered two ineffective steers, treat the
condition as a succession trigger and stop nagging the old thread.

Promote the named standby through the same procedure starting at explicit
successor preparation. The standby receives no traffic before promotion. The
old generation is revoked by the canonical record even when the dead thread
cannot receive a tell.

## Audit traps

- Tells are not reliable evidence in thread history; inspect bounded native
  logs with an explicit limit and count `turn/started` events.
- Bind handoff and watcher stop conditions to the state change that the thread
  no longer holds the role, not to a ceremony name.
- The successor's first act is to re-check the handoff against live state;
  finding a real contradiction is a successful safety check.
