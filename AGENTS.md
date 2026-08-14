# bb-collab repository contract

CONTRACT_VERSION: 8

This repository contains the founding contract and the implemented foundation
through contract v8/schema v10: a single SQLite store with migrations, resolver,
state-event and mutation-receipt, deterministic export, and read-only doctor
seams, plus WorkItem/ExternalWorkRef, role qualification/RoleGeneration,
Assignment/ExecutionAttempt, and typed Decision/EvidenceArtifact/DecisionEvidence
foundations, with a fixture-only MigrationRun cutover contract. Production
RPC/CLI apply require an exact one-request interim operator receipt bound to
project, operation, candidate head, idempotency key, and request digest;
missing, mismatched, consumed, malformed, stale, or retired receipts refuse
before any write. Interim receipts have no local expiry or revocation; they
retire only on the host-issued `get-bb/bb#1541` condition, while stale means
an exact binding mismatch. `github_issue_projection`, `assignment_dispatch`,
and `assignment_reconcile` reserve/finalize adapter operations are explicitly
unsupported under this one-request seam and refuse before the adapter. The
bootstrap operator-confirmation path atomically derives a verified actor receipt
with `actor_kind=plugin`, `subject_id=bb-collab`, and an exact durable
`operator_receipt_id` link; the actor is never a standing identity and must be
supplied with that same operator receipt on apply. Its retirement condition is
the same host-issued `get-bb/bb#1541` condition. The
plugin has not been installed, reloaded, or activated against live project
authority. The complete decision is in
[ADR 0001](docs/adr/0001-founding-contract.md); the threat boundary is in
[the threat model](docs/threat-model.md); import and issue disposition are in
[the import manifest](docs/import-manifest.md); and dependency order is in
[the roadmap](docs/roadmap.md).

## Canonical source boundary

- The bb-collab plugin SQLite database owns canonical governance and work
  state.
- BB core owns native project, source, host, environment, thread, provider and
  event facts.
- GitHub Issues, BB Tasks, Markdown and project files are projection,
  configuration or evidence surfaces only.

No projection, checkout, task label, thread, display name or legacy harness
field can activate work or authorize a canonical mutation by itself.

## Project and repository rules

- A Project is resolved by stable project_id. Never infer it from a display
  name, checkout path, current directory, branch, thread or ordering.
- Project configuration is immutable by revision. A mutation names the exact
  config revision and rejects a stale head.
- A RepositoryTarget has a stable repo_target_id within a project and is
  revisioned with the project configuration. Repository, environment, review,
  release and cleanup operations must name the exact target.
- There is no first-repository, app-repository, current-checkout or
  current-directory fallback.
- Configuration stores secret references, never secret material.
- Permission and visibility are explicit values in each project-config
  revision and execution request. Full permission is a possible starter
  value, never an invisible inherited default.

## Cached-consumer bump test

A contract-affecting change requires one version bump and a test that:

1. enumerates every cached worker and other contract consumer;
2. proves each consumer rereads the new contract or refuses the stale version;
3. records expected, attempted and verified rollout counts; and
4. emits a durable rollout receipt.

Changing version text alone is not a migration. A zero-work result is not a
successful apply unless zero expected work, zero attempted work and zero
verified work are all proven.

Contract v8/schema v10 requires all four cached consumers to reread the
one-request receipt, authorized-approver registry/attestation,
mutation/export/evidence, and refusal contract or refuse contract v7/schema v9.
An adopted operator_only Decision registers approverId=orchestrator:bb-collab
with the exact eight derived mutation classes, including work_item_create and
the two existing role mutation classes. Attestation has no requestInput
interaction and atomically creates the same exact-bound receipt plus verified
plugin actor; operator revocation/change marks the registry unusable.

## Delegation and lane obligations

- Every canonical mutation goes through the one versioned resolver described
  in ADR 0001.
- An Assignment is immutable requested intent. An ExecutionAttempt is separate
  evidence of what BB actually executed. Requested provider, model, reasoning,
  permission and visibility never prove executed values.
- A writing lane has at most one active writer. A project has a hard ceiling
  of two writing lanes and may lower that ceiling, never raise it.
- Read-only review and probe work does not consume the writing cap, but it is
  still assigned, explicitly isolated and bound to the exact project and
  repository target where applicable.
- A delegated worker uses a versioned frozen brief, an isolated managed
  environment, exact branch/base/candidate semantics and a terminal
  DONE|BLOCKED receipt. Native BB/provider events are the execution evidence;
  quiet is not success.
- Automated subagents, if introduced later, are depth one and draft-only.
  They do not own writing, authority, merge, release or operator decisions.

## Review and release obligations

- Tier-A work receives a structurally independent local cold review of the
  exact candidate head. The reviewer has no writing assignment or authorship
  in the lane and emits an exact-head terminal artifact.
- External connector policy is project configuration: required, optional or
  prohibited. Observed capability is separate evidence: available, absent,
  degraded or unknown. Required policy with absent, degraded or unknown
  capability blocks; optional policy may use local review while retaining the
  visible unknown state.
- Review, CI, release and cleanup evidence names the exact repository target,
  candidate or merge SHA, mechanism and discriminating negative case.
- A helper or consult is evidence, never the authority disposition.

Read the [founding ADR](docs/adr/0001-founding-contract.md) before changing
these rules. Do not add a second authority store, mutable Markdown task
database, watcher fleet, custom bus, raw-BB veto claim or untested reverse
migration promise.
