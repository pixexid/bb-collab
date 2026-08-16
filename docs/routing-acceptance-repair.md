# Route-time canonical holder acceptance

This report records the bounded Tier-A routing repair for issue 57. It removes
the dispatcher/supervisor thread identity dependency from the plugin and makes
both dispatcher lane protection and role awareness resolve the current
`project-orchestrator` holder from the canonical role-generation record at
route time.

## Inventory

The durable acceptance inventory is:

```text
seat consumers:     expected=4 attempted=4 verified=4
adjacent consumers: expected=6 attempted=6 verified=6
```

The four seat checks are current-holder selection, lane self-wake
protection, role-event routing, and final pre-send canonical revalidation. The
adjacent checks remain covered by the existing lane, wait, queue, alert,
ledger, and read-only-observation tests.

The focused evidence is in `tests/awareness.test.ts`: the route selects the
canonical holder thread, never substitutes a project-matching dispatcher,
refuses missing/ambiguous/stale/archived/foreign holder evidence, excludes the
current holder from assignment self-wake, and refuses after a holder change
between observation and send. The read seam joins the current head to the
generation's exact `holder_execution_attempt_id`, so an older attempt with the
same role generation is not a target.

## Contract and operational boundary

No doctor/export `roleGenerationHeads` field was added. The existing
`readRoleHolderStates` canonical read already exposes the exact holder thread
needed by route-time consumers, so this repair is not contract-affecting and
does not change schema, migrations, authority, assignment, dispatch,
reconcile, SQLite, receipt, install, reload, or live state.

The motivating routing audit recorded seat consumers `expected=4,
attempted=4, verified=0`; the retired director then received 36
post-succession inbound turns, including approximately 29 completion forwards.
The temporary dispatcher reparent to `thr_gsb7m77ciz`, gsb-only outbound, and
retired-seat archive are evidence and containment bridges, not this repair's
mechanism or a permanent target.
