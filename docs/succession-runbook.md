# Role succession runbook

This is the operational runbook for the director/project-orchestrator seat.
Canonical authority remains the receipt-gated `role_generation_succession`
resolver and its `RoleGeneration` row. This document is guidance, not a
second role store.

## Prepared director-seat amendment

Contract v14 amends the existing `project-orchestrator` requirement as the
`director-seat`. The primary executed profile is exactly
`pi/kimi-coding/k3/high` (`providerId: pi`, `model: kimi-coding/k3`,
`reasoningLevel: high`, `permissionMode: full`, `serviceTier: default`,
`visibility: visible`). Its alternate/standby is exactly Opus-medium
(`claude-code/claude-opus-5[1m]`, `reasoningLevel: medium`, with explicit
full/default/visible fields). The seat has zero writing-lane capacity and
retains the existing ready managed-worktree, exact project/source/host, and
event-correlation checks.

The following is a prepared operator-only Decision payload, not a canonical
Decision row or a succession apply:

```json
{
  "projectId": "proj_a8zzfsx36j",
  "decisionClass": "operator_only",
  "decisionId": "director-seat-amendment-prepared",
  "scope": { "roleRequirementId": "director-seat", "purpose": "succession-rationale" },
  "options": {
    "primaryProfile": "pi/kimi-coding/k3/high",
    "standbyProfile": "claude-code/claude-opus-5[1m]/medium",
    "writingLaneCapacity": 0,
    "environment": "managed-worktree-only"
  },
  "ratification": {
    "epoch1": "thr_krqfdv79xw",
    "epoch2": "thr_gsb7m77ciz",
    "status": "direct-operator-authority-grandfathered-service"
  }
}
```

The epoch-2 holder `thr_gsb7m77ciz` on unmanaged `env_3znzsxb7ce` is not the
generation-3 holder. No historical RoleGeneration row is fabricated; generation
3 is the first recorded director generation. Before any future handover, dry-run
the proposed holder against the current requirement, exact managed environment
and executed profile, and generation head plus one. If that preflight predicts a
refusal, amend the requirement through `config_revision` and its exact operator
receipt first. Then record the succession through the receipt-gated apply before
the successor takes the seat. Operator word or witness evidence alone never
occupies the seat. The current epoch-2 service is grandfathered and remains the
last succession allowed before this recording gate is enforced.

Future bootstrap briefs must report the holder's recorded generation or the
typed refusal that prevented recording; a native witness is not proof of a
seated successor.

## Separate generic orchestrator seat

The ordinary `orchestrator-v1` project-orchestrator requirement is a separate
seat from `director-seat`. Its actual executed profile is the exact profile in
the canonical requirement and native execution evidence; the repository's
current generic fixture is `codex/gpt-5.6-sol/high/full/default/visible`. It
does not inherit the director primary or standby profile. A director seat
must use `pi/kimi-coding/k3/high` with Opus-medium standby as stated above.

## Standby

Every newly recorded generic `project-orchestrator` generation names one
standby profile in `RoleGeneration.standby_profile_json`. The current generic
standby is `luna/gpt-5.6-luna` (`providerId: luna`, `model: gpt-5.6-luna`, with
explicit reasoning, permission, service tier, and visibility). The standby
provider must differ from the holder's executed provider; a same-provider or
missing standby refuses before any canonical write. A standby is not a role,
actor, authority, lease, assignment, dispatch target, or traffic recipient.

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

## Live v13 evidence (2026-08-15)

The live `bb-collab` checkout was refreshed to merge
`468c770ed4f94975ace80bd5d36f5d0b67feaddf` for project
`proj_a8zzfsx36j`. Doctor and export report contract v13/schema v11, with all
four cached consumers reread (`expected=4 attempted=4 verified=4`). The active
standing approver is the exact ten-class registry adopted by
`decision-bb-collab-authorized-approver-v13` (disposition sequence 1).

The recorded project-orchestrator generation is generation 2, predecessor 1,
active, with holder execution attempt
`a10c36147f8a585f94fd140f2caec739e7abeda16ef750f46fad62518db86875` and
executed profile `claude-code/claude-opus-5[1m]/max/full/default/visible`.
Its standby is the witnessed different-provider profile
`pi/zai/glm-5.3/high/full/default/visible`, profile digest
`40047e9f3f3db755b0dd7639860ddcf6e4e2f0a32d13e2acc6a051b440d5cc82`.
The standby witness was native BB thread `thr_3wkgakfr8a`, request sequence
1104 and completed sequence 1218; the holder witness was
`thr_pd39icjc8x`, request event `evt_48i9bwxrea` and completion event
`evt_y9fktuun5e`.

The exact receipt-gated audit chain is: re-adoption mutations/events 26 and
27 (`operator-a1db3f834155e2311513cc53db99f1ea`,
`operator-d48154d6a106cf40caf8aa354a2ba9e1`), qualification mutation/event
28 (`operator-862f446c5a4d61c61c4b07e93aac08ff`), and succession
mutation/event 29 (`operator-a09f45bfb5119774599baa6dffc38da4`). All four
receipts were consumed exactly once. The succession path changed only the
role-generation state: final export counts show two role generations, two
execution attempts, two qualification observations, zero assignments, and
one work item.

That live v13 evidence predates the prepared v14 amendment. It records epoch-1
and epoch-2 service only; this lane performs no live install, reload, Decision,
receipt, SQLite write, succession, or handover. Generation 3 remains held until
the managed-worktree preflight and later receipt-gated apply described above.
