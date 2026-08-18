# GH-104: Assignment profile audit
> Status: The assignment subsystem and lane watcher contract were removed. The assignments table remains as a schema vestige pending consumer enumeration in #192; execution_attempts remains unchanged.


The existing canonical resolver is the recording seam. `assignment_prepare`
stores the immutable requested profile on `Assignment`; `assignment_dispatch`
and `assignment_reconcile` accept only BB-native evidence from the
`NativeAssignmentAdapter`, then store the actual profile and native receipt on
`ExecutionAttempt`. Missing or contradictory native facts remain unknown or
refused; request flags are never copied into executed evidence.

The read-only doctor exposes `profileAudit` from those canonical rows. Each
attempt is `compliant`, `mismatch`, or `unknown`, and a project with no
canonical assignments reports `no_canonical_assignments`. This makes a
post-hoc matrix audit fail closed: zero rows or missing actual evidence is not
evidence of compliance.

This is a schema-neutral contract assessment. It adds no spawn implementation,
second store, raw-SQL authority path, live install/reload, or receipt/SQLite
mutation. A live BB spawn inventory remains outside this plugin until a
sanctioned native adapter is wired by a separately bounded change.
