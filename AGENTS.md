# bb-collab repository contract

CONTRACT_VERSION: 1

This repository contains the founding contract for bb-collab, a BB-native
project-governance and work-lifecycle plugin. The implementation does not
exist yet. The complete decision is in
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
