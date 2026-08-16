# Issue #79: subagent effort audit and default

## Audit

The repository has no bb-collab-owned `threads.spawn` or worker-launcher
implementation. BB core owns native thread spawn; bb-collab owns the existing
Assignment/ExecutionAttempt seam. Assignment intent already requires an
explicit requested provider, model, reasoning, permission and visibility, and
ExecutionAttempt stores the native actual reasoning value. The dispatch path
also rejects an executed profile that differs from the requested profile.

The current authoritative default model is `codex/gpt-5.6-luna` in
`docs/operations-model.md`. Before this issue, that default did not state the
mechanical-subtask reasoning level. The shared `resolveSubagentReasoningLevel`
helper now supplies LOW when a mechanical task omits effort; the cheap-tier
caller selects this default for the mechanical lane. Explicit values, including
HIGH/MAX, remain authoritative, and a hard-core task retains its parent
deliberate level when no override is given.
The brief supplies the cheap-tier classification explicitly; parent effort
does not determine it.

No current spawn inventory exists inside this repository to report as live
worker executions. The conformance boundary is therefore the frozen brief
request plus the existing requested-versus-executed Assignment/ExecutionAttempt
receipt fields; a live BB spawn audit remains outside this plugin's authority.

## Scope decision

This is a brief/default and conformance change only. No contract/schema bump,
SQLite mutation, receipt mutation, queue, second policy store, or plugin
install/reload is required. Issues #78 and #80 are outside scope.

## Validation

`tests/subagent-effort.test.ts` covers omitted mechanical LOW, explicit
hard-core HIGH/MAX, explicit mechanical overrides, and the negative case where
an unrelated parent HIGH level cannot escalate mechanical work.
