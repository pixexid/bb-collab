# ADR 0001: founding contract

- Status: accepted with amendments
- Date: 2026-08-13
- Scope: bb-collab founding documentation and v1 boundary
- Authority: operator-backed adjudication

This ADR is the controlling design decision for issue 1. The GPT-5 Pro
verdict is advisory evidence. The founder adjudication is the disposition.
This repository is a distillation from llm-collab, not a fork or a second
implementation of its historical mechanisms.

## 1. Decision

Found bb-collab as one full-trust BB plugin with one transactional SQLite
authority store, one versioned mutation resolver and one sanctioned mutation
boundary. The plugin owns canonical governance and work state. BB core remains
authoritative for native BB facts. External systems and project files remain
projections, configuration or evidence.

The design adds the two missing boundaries that the advisory verdict
identified:

- WorkItem is the canonical task/issue lifecycle. GitHub Issues, BB Tasks and
  legacy task identifiers are ExternalWorkRef projections.
- ProjectGovernorship is the runtime ownership fence. It is separate from a
  logical role generation and has one monotonic epoch, one current head and a
  fencing token.

Assignment intent and execution evidence are also separate. A requested
profile never proves what BB executed.

## 2. Canonical authority boundary

The authority boundary is literal:

- The bb-collab plugin SQLite database owns canonical governance and work
  state, including project-config revisions, repository targets,
  governorship, role generations, WorkItems, assignments, decisions,
  qualifications, migration receipts, current projections and append-only
  state/evidence events.
- BB core owns native project, source, host, environment, thread, provider and
  event facts. bb-collab stores exact references and execution receipts; it
  does not duplicate BB's entire event stream.
- GitHub Issues, GitHub labels, GitHub Projects, BB Tasks, Markdown and project
  files are projection, configuration or evidence surfaces only. None may
  activate work, satisfy a gate, resolve authority or close a WorkItem
  without passing through the canonical resolver.
- A project repository may hold versioned project-extension source and human
  documentation. It does not hold the live authority database.

No current checkout, branch, display name, provider, model, harness identity,
thread, issue label or legacy authority string is an authority key.

## 3. Conceptual model and exact keys

These are business concepts, not a requirement for one physical table per
concept. Current projections and append-only events may share transactional
infrastructure, but they must not create duplicate authority concepts.

| Concept | Exact key | Required meaning |
| --- | --- | --- |
| Project | project_id | Stable project identity. It is never inferred from a path, display name, current directory, branch or thread. |
| ProjectConfigRevision | project_id, config_revision | Immutable, hashed project extension. ProjectConfigHead(project_id) names the active revision. |
| RepositoryTarget | project_id, repo_target_id, config_revision | Exact registered repository, GitHub slug when applicable, BB project/source/host placement, default branch and project-specific surfaces. repo_target_id is stable across revisions. |
| ProjectGovernorship | project_id, governance_epoch | Governing runtime, state, fencing token, reason, source/target identity and migration receipt. GovernorshipHead(project_id) identifies the one current epoch. |
| RoleGeneration | project_id, role_id, generation | Logical project role holder and succession history. RoleHead(project_id, role_id) identifies the current generation. A role is not a provider, model, harness, app session or display name. |
| WorkItem | work_item_id | Canonical work lifecycle, project, optional exact repository target, state, priority, holds and optimistic revision. |
| ExternalWorkRef | source_system, external_scope_id, external_key | Typed mapping to one WorkItem for a GitHub issue, BB Task or imported legacy task. The external object is not authority. |
| Assignment | assignment_id | Immutable requested authorization: WorkItem, assignment kind, lane, role requirement, target, branch/base/candidate semantics, brief digest, requested profile, parent/depth and idempotency key. |
| ExecutionAttempt | execution_attempt_id | One dispatch attempt under an Assignment, including BB server, thread, environment, host, native correlation IDs, actual profile, lifecycle and terminal evidence. Native references are unique in their BB server scope. |
| Decision | decision_id | Immutable project, scope, class and options identity. A consult does not become an authority decision merely by existing. |
| DecisionDisposition | decision_id, disposition_sequence | Append-only proposed, adopted, rejected, superseded or revoked disposition, with typed actor, conditions, reason and revert. Current state is derived. |
| AuthorizedApprover | project_id, approver_id, authorizing_decision_id, authorizing_disposition_sequence | Durable active/revoked registry row for `orchestrator:bb-collab`, linked to the exact adopted `operator_only` Decision disposition and the five ratified derived mutation classes. |
| QualificationObservation | qualification_id | Immutable fixture-bound capability result for an exact executed-profile digest and observed BB/runtime/fixture context. |
| EligibilityProjection | project_id, role_requirement_id, profile_digest | Rebuildable current eligibility with observation references, expiry and requalification trigger. |
| EvidenceArtifact | evidence_id, content_digest where appropriate | Content-addressed review, test, consult, release, export, receipt or legacy artifact with durable location metadata. |
| MigrationRun | migration_id; unique source_system, project_id, source_export_digest | Idempotent prepare/freeze/export/import/equivalence/activation/rollback receipt. |
| StateEvent | project_id, event_sequence | Append-only mutation history. The current-state mutation and its event commit atomically. |

The project has at most one active writing assignment for a
project_id/lane_id pair. The v1 project-wide writing ceiling is two; a
project may lower it but never raise it. Read-only work does not consume the
writing cap, but remains assigned and isolated.

Exactly one current ProjectGovernorship head exists. A valid canonical write
requires the current head to name the permitted runtime, be in a writable
state, and match the caller's expected epoch and fencing token.

## 4. Project configuration and exact targets

Project configuration is immutable by revision. A revision contains explicit
permission and visibility policy, role requirements, connector policy,
operator holds, project-specific lower lane caps, repository targets and
project-extension surfaces. Secret values never appear in configuration or
exports; only secret references may be stored.

Repository, environment, review, release and cleanup operations require
repo_target_id resolved under the named project and config_revision. A
project-global operation may omit the target only when its operation class is
explicitly repository-independent, such as a project-wide hold update.

There is no first-repository, app-repository, current-checkout,
current-directory, branch-name or repository-slug fallback. Missing,
ambiguous, foreign or stale targets fail closed before checkout, spawn,
review, release or cleanup.

## 5. Single mutation resolver

Every canonical mutation calls one versioned resolver with:

1. project_id;
2. operation class;
3. expected governance epoch and fencing token;
4. expected project-config revision;
5. typed actor, either project_id/role_id/role_generation or an authenticated
   operator actor;
6. exact resource identity such as work_item_id, assignment_id or decision_id
   when applicable;
7. repo_target_id for any repository, environment, review, release or cleanup
   operation;
8. expected aggregate revision for an existing mutable resource; and
9. idempotency key.

The resolver performs these checks in one bounded transaction or a
transactionally protected sequence:

1. Resolve the exact project and active config revision. Reject unknown or
   stale revisions.
2. Resolve GovernorshipHead. Require the expected epoch/token and an operation
   state that permits this mutation.
3. Resolve the exact RepositoryTarget when the operation is target-scoped.
4. Resolve the actor. A role actor must equal the current role head, be active,
   and bind to the holder's recorded ExecutionAttempt. An operator actor must
   use a proven configured authentication/receipt path; a display string,
   thread ID or checkout possession is insufficient.
5. Resolve current qualification and eligibility evidence. Missing, expired
   or contradictory evidence fails when the operation requires it.
6. Resolve operation-specific decisions, holds, WorkItem state, lane
   ownership, environment and review/release prerequisites.
7. Compare the expected resource revision and idempotency key. A matching
   semantic retry returns the original receipt; conflicting reuse fails.
8. Commit the aggregate mutation, StateEvent, evidence references and new
   revision atomically.

The result is a machine-readable AuthorityContext containing resolved project,
config, governorship, actor, repository, resource and evidence revisions.
Refusals are typed; no wrapper may turn a refusal into success.

The contract v6/schema v10 interim operator gate is a one-request grant bound to
the exact project_id, operation class, lowercase 40-character candidate head,
idempotency key and canonical normalized request digest. Consumption is an atomic
compare-and-set in the same transaction as the first StateEvent; an already
consumed receipt refuses, except that the original operatorReceiptId may return
its already-committed idempotent result byte-for-byte. The receipt has no local
TTL or revocation; it retires only on the host-issued `get-bb/bb#1541`
condition, and stale means an exact binding mismatch. The
`github_issue_projection`, `assignment_dispatch`, and `assignment_reconcile`
reserve/finalize adapter paths are unsupported by this one-request gate and
refuse before their adapters. For `bootstrap`, `decision_create`,
`decision_disposition`, `migration_prepare`, and `migration_step`, a confirmed
operator receipt is atomically paired with a verified actor receipt whose `actor_kind` is
`plugin`, whose `subject_id` is `bb-collab`, and whose durable
`operator_receipt_id` points to that exact authorizing receipt. The derived
actor is not standing authority: apply must present the same operator receipt,
and its retirement condition remains exactly the host-issued
`get-bb/bb#1541` condition. The derived actor is omitted from each allowed
derived-class request digest because it is produced by that authorization; all
other request binding fields remain exact. The plugin actor may authorize only
the `operator_only` Decision class and its `adopted` disposition; role-based and
review Decisions remain role-bound. After the one-time adopted authorizing
`operator_only` Decision registers `approverId=orchestrator:bb-collab`, the
`approverAttestation` RPC validates the active registry row, exact authorizing
Decision/disposition, caller plugin, five-class allowlist and exact request
binding, then atomically issues a fresh receipt plus the same verified plugin
actor without `requestInput`. A later operator revocation or change marks the
registry unusable; both registry and interim receipt retain the upstream
host-issued `get-bb/bb#1541` retirement condition, and human confirmation remains
only at that boundary. This is
not live cutover or source retirement.

## 6. Roles, delegation and execution

A logical role is a project-scoped seat such as project-orchestrator or
independent-reviewer. It is never a model, provider, harness, human display
name, app session or current thread.

A RoleGeneration becomes active only after a dispositioned authority decision,
an exact holder ExecutionAttempt, valid project/environment/thread references,
current qualification, and a valid monotonic predecessor relation. Role
states are pending, active, draining, retired or invalidated. Leases,
heartbeat expiry and automatic succession are reserved for post-v1.

An Assignment binds:

- project and WorkItem;
- exact RepositoryTarget when repository state is involved;
- assignment kind and lane;
- role requirement, not a provider or harness identity;
- config revision and governance epoch;
- environment mode, branch, base SHA and candidate semantics;
- explicit requested provider, model, reasoning, permission and visibility;
- versioned frozen-brief format and content digest;
- parent assignment and depth; and
- idempotency key and governed creation decision when needed.

An ExecutionAttempt records:

- exact BB server, thread, environment and host references;
- native command/request and event-correlation IDs;
- actual provider, model, reasoning, permission and visibility from
  provider/BB receipts;
- lifecycle events and timestamps;
- terminal DONE, BLOCKED, FAILED, CANCELED or DISPATCH_UNKNOWN state;
- terminal report digest and evidence references.

The requested tuple is never copied into executed fields. Unknown executed
values remain unknown. If the role or gate requires a known value, the attempt
is ineligible even if its output looks plausible.

One active writer per lane is absolute. A read-only review or probe is
explicitly assigned, uses a clean isolated environment bound to the exact
candidate where applicable, and does not consume the writing cap. An
automated subagent is not a v1 authority path; if used later it is depth one,
draft-only and cannot own a write, review, merge, release or operator action.

The sanctioned worker report is a literal terminal DONE|BLOCKED tell. Native
BB/provider receipts prove lifecycle; silence, a status read, a reaction or an
empty container does not.

## 7. Review, release and connector policy

Structural independence is universal for Tier-A work. The final reviewer is a
distinct ExecutionAttempt with no writing assignment, commit authorship or
lane ownership. It reads the complete base-to-candidate diff in a clean
read-only environment and emits a terminal artifact bound to the exact
candidate SHA. Different-provider review is the starter project policy where
qualified capacity exists; provider diversity does not substitute for
structural independence.

Connector policy and observed capability are different facts:

- Policy is stored in ProjectConfigRevision and is required, optional or
  prohibited for an exact repository target and connector.
- Capability is an immutable observation, recorded with exact target,
  connector identity/version, fixture, time, expiry and evidence digest. Its
  states are available, absent, degraded or unknown.
- A ConnectorGateProjection combines the two for display and evaluation. It
  is derived and rebuildable.
- Silence never proves absence or success. An absent observation requires an
  authoritative control-plane or repository result. An available observation
  requires installation/enrollment/configuration evidence plus a bounded
  exact-head terminal-artifact fixture.

| Policy | Capability | Result |
| --- | --- | --- |
| required | available | Require one valid external first pass bound to the candidate, final independent local exact-head review and normal gates. |
| required | absent, degraded or unknown | Block before merge with CONNECTOR_REQUIRED_UNSATISFIED. Change policy only through a governed config revision. |
| optional | available | Run the connector when configured. Its result is evidence, not authority; local independent review remains required. |
| optional | absent, degraded or unknown | Proceed with independent local review and visible typed capability state. Do not relabel unknown as absent. |
| prohibited | any | Do not transmit repository material to the connector. Use local review or another explicitly permitted reviewer. |

One-pass connector semantics:

1. Freeze candidate H0 and request one connector pass when policy is required
   and capability is available.
2. Accept only a terminal artifact bound to H0.
3. Adjudicate findings once. A bounded amendment may create H1.
4. Run final independent local exact-head review on the final candidate.
5. Do not repeat the connector pass when changes are confined to adjudicated
   findings and the amendment scope is recorded.
6. A material unrelated change, changed base, force-push ambiguity, new
   high-risk surface or amendment-cap breach invalidates the first-pass lane.
   Create a new review generation and connector pass when required.
7. Timeout, empty container, pickup signal, reaction and missing terminal
   artifact remain pending or failed evidence.

Release and CI evidence identifies the exact repository target, workflow/run,
trigger ref, candidate or merge SHA and terminal conclusion. A green result
from another repository or ref is not evidence. Cleanup is a separate action;
thread archival is never an environment-destruction receipt.

## 8. Conformance and external projections

bb-collab has one conformance surface with a read-only default and an explicit
apply/provision mode. It validates the exact BB and plugin versions, project
and config identity, repository targets, runtime dependencies, GitHub access
when configured, WorkItem projection, native worker observation,
managed-worktree readiness, role requirements, review/release surfaces,
connector policy/capability and configured secret/ignored-state references.
Each result names the inspected subject and evidence.

Provisioning is idempotent, followed by remote/state verification. Zero work
is not successful application unless expected, attempted and verified counts
prove zero. GitHub Issues is the first projection. BB Tasks may be added only
as a one-way operator projection after a prototype proves it cannot become a
second authority.

## 9. Typed fail-closed outcomes

| Condition | Typed result | State effect |
| --- | --- | --- |
| Unknown project or stale config | PROJECT_UNKNOWN or PROJECT_CONFIG_STALE | No mutation. Report expected and current revisions. |
| Missing, ambiguous, foreign or stale repository | REPO_TARGET_REQUIRED, REPO_TARGET_AMBIGUOUS, REPO_TARGET_FOREIGN or REPO_TARGET_STALE | No checkout, spawn, review, release or cleanup. |
| Guard unavailable, project frozen or stale epoch/token | GOVERNOR_UNAVAILABLE, PROJECT_FROZEN or GOVERNOR_EPOCH_STALE | No source or target canonical write. Diagnostics remain read-only. |
| Retired, wrong or mismatched role generation | ROLE_GENERATION_STALE, ROLE_NOT_ACTIVE or ROLE_HOLDER_MISMATCH | No authority action and no provider/thread/display fallback. |
| Missing, expired or contradictory qualification | ROLE_UNQUALIFIED or CAPABILITY_UNKNOWN | No role activation or review gate. Evidence remains readable. |
| Stale WorkItem, decision or assignment revision | RESOURCE_REVISION_STALE | No lost update; reread and re-disposition. |
| Active writer already owns a lane | LANE_WRITER_EXISTS | No second writing assignment or dispatch. Read-only work may remain separate. |
| Native spawn acknowledged without correlated start/terminal evidence | DISPATCH_UNKNOWN | Emit reconciliation evidence; do not blind-retry. |
| Actual execution profile missing or mismatched | EXECUTION_PROFILE_UNKNOWN or EXECUTION_PROFILE_MISMATCH | Attempt is truthful evidence but cannot satisfy the required role or assignment. |
| Worker dies or quota-fails before terminal report | FAILED | Keep WorkItem nonterminal or blocked according to policy. |
| Required connector absent, degraded, unknown or nonterminal | CONNECTOR_REQUIRED_UNSATISFIED | Merge readiness remains blocked. |
| Review artifact is bound to an old or moved head | REVIEW_HEAD_STALE | Invalidate the review gate. |
| External projection differs from canonical state | PROJECTION_DRIFT | Rebuild from canonical state; do not mutate authority to match projection. |
| Dirty, unique or unresolved environment state | ENVIRONMENT_NOT_DISPOSABLE | Refuse destruction/archive coupling and report exact blockers. |
| Import hash, key, count or reference mismatch | IMPORT_EQUIVALENCE_FAILED | Target remains non-writing and source remains frozen. |
| Source freeze does not cover expected mutators | SOURCE_FREEZE_UNPROVEN | Do not activate target; report expected, attempted and verified canaries. |
| Unmanaged BB thread or direct repository activity | UNMANAGED_ACTIVITY | No role, lane, gate or closure authority; affected closure is blocked until discarded or adopted. |
| Plugin database unavailable or corrupt | CANONICAL_STORE_UNAVAILABLE | All governed writes stop. Projections and legacy state cannot take over. |

Every mutation either commits its aggregate change, StateEvent, evidence
references and new revision in one transaction or commits none. No shell
normalization, projection or wrapper may turn a refusal into success.

## 10. One-governor cutover

The fence is a ProjectGovernorship row in the plugin database, installed in
shadow/read-only mode before cutover and consulted by every sanctioned source
and target mutator, importer and projection synchronizer. It contains:

- project_id;
- monotonic governance_epoch;
- governor_runtime, either llm-collab or bb-collab;
- state: source_active, frozen, target_active or retired;
- an unguessable fencing token;
- source runtime/contract identity and target plugin/schema identity;
- source export digest and imported snapshot sequence when applicable;
- activation/freeze timestamp, disposition decision and canonical mutation
  sequence.

Every sanctioned mutation presents the expected epoch/token. Compare-and-swap
rejects stale processes. If the guard cannot be reached, both source and
target fail closed for project writes. Native activity outside the guard is
the enforcement ceiling and is reported as unmanaged.

The amended sequence is:

1. Prepare: install and pin bb-collab in shadow mode, create the project/config
   and source_active epoch, validate dry-run import and refuse target writes.
2. Instrument source: enumerate every sanctioned llm-collab mutator, require
   the shared epoch/token, run mutation canaries and record the mutator digest.
3. Quiesce: prove no active writer/reviewer/release operation, unresolved
   dispatch, unpreserved dirty state or other blocker.
4. Atomic freeze: compare-and-swap source_active to frozen, rotate the token,
   capture source snapshot/digest and prove representative mutators return
   PROJECT_FROZEN without changing state.
5. Deterministic export: emit versioned manifest, stable records, artifact
   index and checksums at the frozen event sequence.
6. Deterministic import: import idempotently by source system, project and
   export digest. Validate keys, references, exact heads, holds and evidence,
   not counts alone. Keep target non-writing.
7. Equivalence: compare canonical keys and hashes, rebuild projections and run
   read-only doctor, repository, decision and release checks.
8. Atomic target activation: compare-and-swap frozen to target_active, rotate
   the token, create a new governance epoch and record the activation
   disposition. Source writes now fail stale or frozen.
9. Routine exercise: run one ordinary non-spend, non-production-migration
   lane through assignment, execution, review, release evidence and closure.
10. Source retirement: after the exercise and observation window, retire the
    source epoch while retaining read-only audit/export access.

The interval between freeze and target activation has no writer.

## 11. Export, legacy import and rollback

The logical export contains:

- manifest.json with schema/runtime, project, governance epoch, config
  revision, snapshot sequence, counts and root digests;
- stable-order records.ndjson for entities and events;
- artifact index with content digests and durable references;
- checksums.sha256 covering every emitted file.

A raw SQLite copy may be a backup, but it is not the migration contract.

Legacy import preserves facts, not implied authority:

- retain original bytes or durable location, digest, source runtime/version,
  project and import time;
- import values such as created_by, refined_by, accepted_by and
  release_gate_agent as LegacyClaim evidence, preserving literal source
  semantics;
- never manufacture a role generation from claude, codex, supervisor or any
  other harness string;
- keep supervisor acceptance overrides as task-scoped historical evidence,
  not as a bb-collab actor;
- retain terminal records as terminal snapshots rather than replaying every
  old transition;
- keep nonterminal imports read-only until an active role or operator issues
  an explicit adoption disposition;
- mark ambiguous or incomplete authority unresolved; it cannot activate,
  resume, release or close work;
- emit no legacy authority field from a new write path.

Before target mutation, rollback requires imported and target mutation
sequences to match, unchanged source/export and external heads, no
target-created canonical or projection mutation, and a successful new
source_active epoch plus source canaries.

After any target canonical mutation, use fix-forward/read-only recovery. A
reverse migration is allowed only through a separately implemented,
lossless, fixture-tested adapter under a new decision and governorship epoch.
Do not silently reopen the stale source.

Plugin/schema upgrades require a verified backup and deterministic export,
exact BB/plugin compatibility validation, cached-consumer enumeration,
transactional migration where possible, and post-upgrade doctor plus
discriminating mutation fixtures. Do not roll back code without its schema or
data pair.

## 12. Operator policy and unresolved decisions

The founding direction adopts:

- one central BB server and one full-trust bb-collab database, revisited only
  before first project cutover if backup/two-host probes fail;
- full permission as an explicit starter project-config value, never an
  invisible execution default;
- universal structural review independence, with different-provider review as
  the starter policy where qualified capacity exists;
- GitHub Issues as the first projection and BB Tasks deferred until a one-way
  prototype proves non-authority;
- fix-forward/read-only recovery after a target write;
- a standard one- or two-repository project reaching one routine closed lane
  in at most four operator hours without shared code edits, manual database
  edits, watcher processes, label loops or spawn exceptions;
- public repository visibility and no inferred license.

The following remain unresolved until the named proof or operator decision:

- General operator actor authentication. Do not infer identity from a display
  name, checkout possession or thread ID. The narrow exception is the
  explicitly ratified `plugin/bb-collab` derived actor for the bounded
  bootstrap, operator-only Decision, and migration mutation classes, which is
  issued by an active exact authorized-approver attestation and remains bound
  to its exact operator receipt; other operator actors still wait for a proven
  BB-native authenticated subject/receipt or a separately explicit decision.
- Connector policy per repository. Set required, optional or prohibited only
  after the exact installation and terminal-artifact probe. Capability
  observations cannot rewrite policy.

## 13. Disposition register

The advisory verdict is adopted only through these dispositions:

| Advisory ruling | Disposition |
| --- | --- |
| Logical role/current generation | Amend: keep RoleGeneration and RoleHead with pending, active, draining, retired and invalidated states; add separate governorship. |
| Assignment/execution | Amend: split immutable Assignment intent from one-or-more ExecutionAttempt receipts. |
| Decision/provenance | Amend: immutable Decision, append-only dispositions and advisory EvidenceArtifact relations. |
| Capability/qualification | Amend: immutable QualificationObservation keyed by executed-profile and runtime/fixture digest; derive EligibilityProjection. |
| Project extension | Amend: immutable config revisions and stable repository targets; store secret references only. |
| Missing WorkItem | Reject the omission: add canonical WorkItem and ExternalWorkRef. |
| Missing ProjectGovernorship | Reject the omission: add one epoch/head/fence. |
| Evidence and migration as incidental fields | Amend: add EvidenceArtifact, StateEvent and MigrationRun. |
| Native-first storage | Ratify with amendment: one BB plugin SQLite database, not a second service or daemon. |
| Twelve universal clauses | Ratify/amend individually in the import manifest and this ADR; add clause 13 for conformance. |
| Connector review | Amend: separate policy from capability and apply the complete truth table above. |
| Cutover protocol | Amend: shared CAS guard, source instrumentation, canaries, no-writer interval, equivalence and post-write fix-forward. |
| Economic test | Amend: add read-only doctor, explicit apply/verify, zero-work proof and the four-hour executable target. |
| Physical enforcement | Ratify the ceiling: only sanctioned canonical mutations are enforceable; raw BB/admin/Git/filesystem activity cannot be physically vetoed by this plugin. |

## 14. v1 required, reserved and cut

Required:

- stable keys and revisions for every concept in section 3;
- exact project, config and repository binding;
- governorship epoch/fence and current head;
- role generation/head and minimum qualification;
- WorkItem and external references;
- assignment intent, branch/base/candidate semantics and frozen-brief digest;
- execution receipts with requested/executed separation;
- decision/disposition, evidence and operator holds;
- environment identity, review/release evidence and cleanup refusal;
- deterministic export/import, equivalence and migration receipts;
- adversarial fixtures and one routine first-adopter lane.

Stable keys may exist while behavior is deferred for renewable leases,
heartbeat expiry, automatic succession, provider capacity/cost brokerage,
custom transport, automated subagents, multi-server availability, a generic
workflow engine, a dashboard, broad plugin marketplace policy and
model-specific qualification campaigns.

Explicitly cut from v1 are automatic failover, custom bus/inbox/watchers,
automated delegation trees, dashboard/control-plane work, BB Tasks or GitHub
labels as authority, universal product automation, full legacy chat replay,
standing supervisors, Fable-specific routing, invisible permission defaults,
raw-BB veto claims, multi-server active-active authority and untested
post-write reverse migration.

The detailed surviving clause and issue ledger is
[docs/import-manifest.md](../import-manifest.md). The dependency-ordered
implementation and adoption evidence are in
[docs/roadmap.md](../roadmap.md).

## 15. Evidence and source fence

The public evidence surface is the
[approved founding gist](https://gist.github.com/pixexid/77c7ac47afc27a63a147159195ba56b7).
The source fence is
[llm-collab commit f988d9711d3778f751e4ec0e32ebbf7b0893c80f](https://github.com/pixexid/llm-collab/tree/f988d9711d3778f751e4ec0e32ebbf7b0893c80f).
The founding issue is
[pixexid/bb-collab issue 1](https://github.com/pixexid/bb-collab/issues/1).
The BB founding pin observed for this docs lane is 0.37.0; later code must
read the exact generated plugin SDK declarations instead of relying on this
documentation pin.

Verified attachment hashes:

- Founder adjudication:
  9e45d19f489b3bbcde16325f6a4ad57fac70ee67a11ac2ef1eac0f35b2f99fab
- GPT-5 Pro verdict:
  6a161e84106126cd8fe1ad949f450a6adc54853e0d844e0c1dc4461bc4a77447

The local attachment paths are evidence for this run only. The public gist,
issue and source-fence links above are the durable source references.
