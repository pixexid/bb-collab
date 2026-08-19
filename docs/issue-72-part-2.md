# Issue #72 Part 2: wrongful-idle detector

The existing `lane-watcher` observes the current active `project-orchestrator`
RoleGeneration and the existing `openLaneViews` queue. It reports a wrongful
idle only when the role thread is idle for at least 10 minutes, its project has
an un-deferred `nextStartable` lane, and the native thread/wait read is known.

The watcher sends one pointer-only `agent-only` steer to the
`project-orchestrator` seat, keyed in plugin KV by
`project_id`, role, generation, and queue-head execution attempt. The key is
cleared when the role becomes active, the queue head changes, the lane is no
longer startable, or an operator deferral explains the pause. The persisted
record anchors the first observed compound idle-and-startable condition so a
stale or changed native thread timestamp cannot collapse the bounded window.
A successful steer's active interval is retained until the role returns idle,
then the condition window is re-anchored; a later active interval clears the
record. A second steer is
allowed only after another ten minutes of the unchanged condition. Two failed
sends escalate immediately; two delivered steers that remain ineffective are
escalated only after the next unchanged observation window. Either case emits
one `wrongful_idle_fyi` and one
`onRoleSuccessionRequired` notification, then stop; succession remains the
existing ratified, receipt-gated path and is not applied by the watcher.

This is awareness only: it adds no role generation, assignment, dispatch,
receipt, SQLite, console, or GitHub mutation, and it does not create or record
the Part 1 standby seat. The standby is recorded by the existing
receipt-gated RoleGeneration succession path described in
[the succession runbook](succession-runbook.md).

## Director-seat recording gate

> Current 2026-08-19 contract v22: the `director-seat` requirement uses `pi/kimi-coding/k3/high` with `claude-code/claude-opus-5[1m]/medium` standby. The pair remains symmetric: either ratified profile may hold the seat with the other as standby, subject to the rule that standby and holder providers must differ. The historical text below is retained as issue-record history and is not current operational instruction.

Contract v17 supersedes this historical v15 director-seat note. `director-seat`
is the separate `director` role with the same primary `pi/kimi-coding/k3`,
Opus-medium standby, and zero writing-lane capacity. The only unmanaged
exception is director generation-1 qualification recording and creation for
holder `thr_gsb7m77ciz`, environment `env_3znzsxb7ce`, and source
`src_x8veidmpik`, receipt-gated with no predecessor and no existing director
head; it cannot admit writing, foreign or stale contexts, or later generations.
Every later director generation requires a managed isolated worktree.

The seat-succession recording gate is explicit: preflight the proposed holder
against the current requirement, executed profile, exact managed environment,
and generation head plus one. If the preflight refuses, amend the requirement
through the normal immutable full-config `config_revision` plus exact operator
receipt before attempting succession. Record the generation before the
successor takes the seat; operator word or a native witness never establishes
occupancy. Director generation 1 is the first row that may be recorded under this gate.
Future bootstrap briefs report that generation or the typed refusal, not witness
evidence alone. This lane performs no live spawn, receipt, console approval,
SQLite write, succession, or handover.
