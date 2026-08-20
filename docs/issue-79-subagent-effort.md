# Issue #79: subagent effort audit and default

## Audit

The repository has no bb-collab-owned `threads.spawn` or worker-launcher
implementation. BB core owns native thread spawn; bb-collab owns the existing
Assignment/ExecutionAttempt seam. Assignment intent already requires an
explicit requested provider, model, reasoning, permission and visibility, and
ExecutionAttempt stores that request provenance under `requested_*` names. BB
does not expose authoritative executed reasoning or profile readback, so the
store cannot reject quiet execution divergence after the fact.

The current authoritative default model is `codex/gpt-5.6-luna` in
`docs/operations-model.md`; that matrix states LOW for mechanical subagents.
Explicit values, including HIGH/MAX, remain authoritative, and a hard-core task
retains its parent deliberate level when no override is given.
The brief supplies the cheap-tier classification explicitly; parent effort
does not determine it.

No current spawn inventory exists inside this repository to report as live
worker executions. The conformance boundary is therefore the frozen brief
request plus requested-profile provenance. Executed-profile conformance remains
unknown under GH-215 and upstream get-bb/bb#1787; a live BB spawn audit remains
outside this plugin's authority.

## Scope decision

This is a brief/default and conformance change only. No contract/schema bump,
SQLite mutation, receipt mutation, queue, second policy store, or plugin
install/reload is required. Issues #78 and #80 are outside scope.

## Validation

There is no in-repo spawn implementation or consumer to test; the normative
rule remains in `docs/operations-model.md` and BB core owns native spawn.
