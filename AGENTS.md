# bb-collab repository contract

CONTRACT_VERSION: 15

This repository contains the founding contract and the implemented foundation
through contract v15/schema v11: a single SQLite store with migrations, resolver,
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

The role requirement seam admits at most three logical roles: project-orchestrator
is project-scoped, while worker and independent-reviewer require an exact
repository target; each requirement binds an executed-profile qualification.

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

Contract v15/schema v11 requires all four cached consumers to reread the
one-request receipt, authorized-approver registry/attestation,
mutation/export/evidence, role IDs/scoping, and refusal contract or refuse
contract v14/schema v11.
An adopted operator_only Decision registers approverId=orchestrator:bb-collab
with the exact ten derived mutation classes, including config_revision,
work_item_create, work_item_transition and
the two existing role mutation classes. Attestation has no requestInput
interaction and atomically creates the same exact-bound receipt plus verified
plugin actor; operator revocation/change marks the registry unusable. The
historical contract-v9 eight-class registry was accepted only during the
one-release v9-to-v10 re-adoption. Contract v15 leaves the exact current
ten-class allowlist unchanged; the already-bounded v11 nine-class repair
remains readable for authority maintenance, but does not authorize
`work_item_transition`. Malformed, reordered, subset, extra, v9, or other
arbitrary sets refuse at attestation and apply. This v15 change is a semantic
contract bump for the current-generation director-seat environment exemption:
CONTRACT_VERSION and contractDigest change;
SCHEMA_VERSION, schemaDigest and migrations remain unchanged, and all four
cached consumers emit a durable reread/refusal rollout receipt. The
`director-seat` requirement remains the existing `project-orchestrator` role,
requires the exact `pi/kimi-coding/k3/high` primary profile and the exact
Opus-medium standby, and has zero writing-lane capacity. Only the exact current
generation 2 / holder `thr_gsb7m77ciz` / environment `env_3znzsxb7ce` / source
`src_x8veidmpik` may record its current qualification from the approved unmanaged
canonical environment. Every future generation requires the existing managed,
isolated worktree and exact source/environment checks; the exemption is not
general, cannot admit writing, and future succession remains receipt-gated.

## Delegation and lane obligations

- Every canonical mutation goes through the one versioned resolver described
  in ADR 0001.
- An Assignment is immutable requested intent. An ExecutionAttempt is separate
  evidence of what BB actually executed. Requested provider, model, reasoning,
  permission and visibility never prove executed values.
- A writing lane has at most one active writer. Each orchestrator has an
  explicit `extensions.bbCollab.writingLaneCeiling` dial, defaulting to 3 for
  bb-collab and bounded at 3; it may be lowered by canonical configuration but
  is never silently raised. Read-only review and probe work does not consume
  the writing cap, but it is still assigned, explicitly isolated and bound to
  the exact project and repository target where applicable.
- A delegated worker uses a versioned frozen brief, an isolated managed
  environment, exact branch/base/candidate semantics and a terminal
  DONE|BLOCKED receipt. The brief and its PR body declare the derived review
  tier and exactly one lifecycle disposition: `Closes #NN` only with an
  explicit `Acceptance: complete`, `Related GH-NN` otherwise, or a rare
  `No issue: <rationale>`. No Fix/Close/Resolve keyword may appear unless the
  close disposition and acceptance declaration are both valid. Native
  BB/provider events are the execution evidence; quiet is not success.
- Mechanical subagent work (fixtures, sweeps, doc sync and scaffolds) declares
  LOW reasoning in its spawn brief by default. Omitted effort is LOW on cheap
  tiers; a parent's HIGH or MAX effort is not inherited by mechanical work.
  Hard-core work may retain HIGH or MAX only through an explicit request.
  Assignment/ExecutionAttempt evidence compares requested and executed
  reasoning; this is a brief/receipt rule, not a second queue or authority
  store.
- Automated subagents, if introduced later, are depth one and draft-only.
  They do not own writing, authority, merge, release or operator decisions.

## Review and release obligations

- Tier-A work receives a structurally independent local cold review of the
  exact candidate head before merge. Tier-B work merges on local verification
  and CI, then receives cold review post-merge in parallel; a confirmed serious
  defect follows the existing revert path, otherwise findings become follow-up
  work. Tier-C documentation, mechanical edits and additive tests use local
  verification and CI only.
- Every PR body contains one `Review tier: A|B|C` declaration. The tier is
  derived from touched surfaces, and wrong-tiering is a review finding. The
  stateless check in `scripts/check-review-tier.mjs` only validates metadata;
  it is not authority or queue state.
- Every PR body also contains exactly one lifecycle disposition line. Verify
  rejects missing or ambiguous linkage, premature close keywords, and a close
  claim without `Acceptance: complete`; GitHub issue state remains projection
  evidence and never canonical governance.
- Verify may read the linked GitHub issue only to validate target existence and
  explicit state; a `Related GH-NN` target must still be open, and the checked
  PR commit history must contain no conflicting close-like linkage. `issues:
  read` and branch-protection/ruleset enforcement of the Verify check are
  external prerequisites, not canonical authority.
- The merge-only `pull_request_target` workflow uses `issues: write` only with
  code checked out from `refs/heads/main`; it never executes the PR head or
  merge ref. Its deterministic marker/concurrency path is projection evidence,
  not canonical governance.
- The lifecycle disposition, Verify, merge-comment, and audit rules above are
  external CI/release conformance projections. They do not change the
  canonical contract, `CONTRACT_VERSION`, `contractDigest`, schema, cached
  consumers, or rollout receipts; this lane therefore does not invoke the
  cached-consumer bump test. Any future canonical authority or contract change
  still requires that bump test.
- Tier-A surfaces include authority/provenance, canonical DDL/lifecycle,
  operator receipts/approval, spend, concurrency/atomicity, migration/cutover,
  review/release policy, and tracked runtime artifacts. The next unrelated
  lane may start while a Tier-A review runs; only the candidate merge waits for
  its review.
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
