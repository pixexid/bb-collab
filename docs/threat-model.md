# bb-collab threat model

This document defines the threats the founding contract must fail closed
against and the boundary it cannot honestly enforce. The full schema and
resolver contract are in [ADR 0001](adr/0001-founding-contract.md).

> Current correction (2026-08-19, contract v34): execution-profile claims in
> this dated contract record were later disproved by GH-228. The store holds
> request provenance from `client/turn/requested`, not authoritative executed
> readback; that gap remains GH-215 and upstream get-bb/bb#1787. The body below
> is preserved with its period terminology and assertions.

## Scope and trust boundaries

bb-collab governs canonical records and sanctioned mutations for a project. It
does not turn every process on an operator-controlled host into a trusted
worker.

| Boundary | Trusted fact or asset | Required behavior |
| --- | --- | --- |
| BB core | Native project, source, host, environment, thread, provider and event facts | bb-collab records exact references and receipts; it does not replace BB core authority. |
| bb-collab plugin database | Project configuration, repository targets, governorship, roles, WorkItems, assignments, decisions, qualifications, evidence, migration, current projections and operator-inbox messages | One transactional store; unavailable or corrupt means governed writes and inbox delivery stop. Inbox text is communication, never decision authority. |
| Governorship fence | Current runtime, epoch, token and mutation sequence | Every sanctioned source, target, import and projection mutation presents the same expected epoch/token. |
| Cross-project bootstrap authority | Source governor claim, exact adopted Decision, target genesis receipt, and operational actor receipt | A source must be `target_active` at the exact fence/epoch and bound to a verified bb-collab plugin actor; an exact `operator_only` project-scoped Decision names the cross-project source/target scope; one audited genesis receipt is atomically consumed for one named target and cannot authorize later mutations; a distinct audited operational actor receipt owns the target governorship. |
| Project repository and worktrees | Versioned project extensions, candidate code and human documentation | Exact target, branch, base and candidate identity are required; a checkout never proves authority. A native ready managed worktree may use a derived path, but its exact project/host/source binding and both source and environment paths are retained. |
| GitHub, BB Tasks and Markdown | External projections or evidence | They may not activate work, satisfy a gate or close a WorkItem independently. |
| Operator/admin/raw BB activity | Unmanaged activity on a full-trust host | It may be detected as evidence or discrepancy, but it acquires no canonical authority by observation. |

Role requirements are bounded at four logical roles: director and
project-orchestrator are project-scoped, while worker and independent-reviewer
bind to an exact repository target. `director-seat` is the only director
requirement and has zero writing-lane capacity. Each role requirement carries
its executed-profile qualification; this adds no assignment or dispatch
authority.

The v20/schema v12 contract retains the v10 operator gate, which has a host/UI
confirmation boundary only for authorizing or revoking the approver. An adopted
`operator_only` Decision
registers `approverId=orchestrator:bb-collab` for the exact project and adopted
disposition, with the ten ratified derived mutation classes, including
`config_revision` for the existing canonical mutation that replaces the full
immutable project configuration and its mapped targets, including
`roleRequirements` provisioning,
`work_item_create`, `work_item_transition`, `qualification_observation_record`, and
`role_generation_succession`. The
`approverAttestation` RPC validates that active registry row, exact Decision
and disposition, caller plugin, and request binding, then atomically issues a
fresh interim receipt plus verified plugin actor with no pending UI interaction.
The exact current ten-class set authorizes all current classes. Contract v13
leaves that allowlist unchanged. The already-bounded v11 nine-class set remains
readable but does not authorize `work_item_transition`; authority-maintenance
re-adoption installs the exact current ten-class set.
Malformed, reordered, subset, extra, v9, and arbitrary other sets refuse at
both attestation and apply. Revocation or change marks the registry revoked and
attestation fails closed. The receipt binds one exact project, operation class, lowercase
40-character candidate head, idempotency key and canonical normalized request
digest. The shared authorization-digest projection normalizes omitted nullable
fields to `null` and projects expected config/governor/fence guards to `null`;
apply still validates those live guards separately and fails closed when stale.
Project, operation class, candidate head, idempotency key, and all other request
content remain bound. Every current receipt records explicit issuance provenance:
console issuance is `console`, authorized-approver issuance is `attestation`,
and provenance is never inferred from approver fields or digest shape. A fresh
legacy NULL or unknown apply refuses before write. After a mutation receipt
proves the same exact request and operator receipt already committed, replay
returns the stored outcome without revalidating that consumed receipt's
provenance; different receipt or binding values still refuse. A
`config_revision` plugin actor remains bound to this exact receipt under either
current provenance. Both the registry and interim receipt retain the upstream host-issued
`get-bb/bb#1541` retirement condition. The first committed StateEvent consumes it atomically; reuse, a
different receipt for an already-committed idempotency key, or any binding
mismatch refuses before a write. It has no local TTL and retires only on the
host-issued `get-bb/bb#1541` condition. The historical contract-v9 eight-class
registry was accepted only during the one-release v9-to-v10 re-adoption.
Historical contract v11 required the exact nine-class set; historical contract v12 added only
`work_item_transition`. Historical contract v14 added the bounded `director-seat`
requirement with the exact primary `pi/kimi-coding/k3/high` and Opus-medium
standby profiles, zero writing-lane capacity, and the existing
managed-worktree/source/environment checks. Historical contract v15 added only the exact
current-generation qualification exemption for generation 2, holder
`thr_gsb7m77ciz`, environment `env_3znzsxb7ce`, and source `src_x8veidmpik`.
The current head and holder execution attempt remained required; foreign, stale,
wrong-profile, future-generation, succession, and writing requests refused
before any write. The grandfathered unmanaged epoch-2 service could not establish
generation-3 occupancy without a later receipt-gated succession. Contract v17
supersedes those historical v13-v15 rules: only director generation 1 uses the
exact holder/environment/source qualification-and-creation exemption, only director generations carry the
named different-provider standby, and project-orchestrator generations omit it.
Historical contract v16 additionally rejected a native thread designated as a witness by
its title or title fallback before qualification or succession could materialize a
holder attempt; it preserved the existing role/head, environment/source, and
executed-profile checks. Stale v16 consumers refuse, current v17 consumers reread,
and schema/migrations remain unchanged by this role-policy
amendment. The dial is a canonical config revision recorded through the adopted
Decision and operator-authorized `config_revision` seam; review and probe
Assignments are excluded from the writing count.
`github_issue_projection`,
`assignment_dispatch`, and `assignment_reconcile` reserve/finalize paths
refuse before external adapters because one receipt cannot authorize multiple
writes. This seam is fixture-tested and does not claim live cutover.

The plugin database is the sole canonical governance/work store. A second task
ledger, role store, decision store, migration registry, daemon or mutable
Markdown authority would recreate the split-state threat.

Cross-project bootstrap is intentionally narrow. The current root of trust is
host-local operator control represented by the verified bb-collab plugin actor
and an exact adopted `operator_only` Decision whose immutable project-scoped
scope names `cross_project_bootstrap`, the source project, target project, and
`repoTargetId: null`; its options must name `host_local_operator`. The resolver
derives separate target genesis and operational plugin actors and writes
`bootstrap_derivation_receipts` in the same transaction as the target config,
repository targets, governorship, state event, and mutation receipt. The
genesis receipt is single-use and `requireActor` rejects it for governor,
config, Decision, qualification, succession, and every other later mutation;
only the distinct operational receipt owns the target governorship. Stale
source fences/epochs, frozen or missing source governorship, non-plugin or
invalid source actors, unrelated classes, wrong source/target/scope/options,
unadopted Decisions, reused/retargeted genesis receipts, and existing target
state fail closed.
Host-issued operator receipts from get-bb/bb#1541 are the preferred future root
and require a new authority ruling before this derivation path changes.
The v29 migration has an explicit predecessor rule for v28 rows with a
genesis-backed epoch-1 governorship: the legacy receipt may continue ordinary
mutations only while it remains the current target governor, but the shared
genesis detector still refuses it as a source governor. The generic `apply`
boundary enforces the same exact `registerProject` projection and rejects
target Decisions or other excluded fields before any bootstrap write.

## Assets and security goals

The system protects:

- project and repository identity;
- config and repository-target revisions;
- the one current governorship epoch and fencing token;
- role-generation and holder provenance;
- WorkItem lifecycle and lane ownership;
- requested-versus-executed execution identity;
- decisions, dispositions, qualifications and evidence;
- review, release and environment-safety gates;
- migration snapshots, digests and rollback state; and
- truthful terminal and adoption receipts.

The goals are:

1. A canonical write is attributable to the exact project, config, governor,
   actor, target, resource and idempotency request.
2. A stale, ambiguous, foreign or unqualified actor cannot become authority by
   guessing a name, provider, thread, branch or checkout.
3. A projection or consult cannot silently become canonical state.
4. A green, empty or quiet signal cannot exceed what its mechanism proves.
5. Source and target cannot both be sanctioned governors during cutover.
6. A failed proof does not destroy unique environment or migration state.

## Threats and controls

| Threat | Failure mode | Control and typed result |
| --- | --- | --- |
| Harness-era identity | A provider, model, harness name or display name is treated as a role or actor | Typed RoleGeneration and actor references; ROLE_NOT_ACTIVE, ROLE_GENERATION_STALE or ROLE_HOLDER_MISMATCH. |
| Wrong project | A checkout, current directory or thread selects a neighboring project | Stable project_id and config revision; PROJECT_UNKNOWN or PROJECT_CONFIG_STALE. |
| Wrong repository | First/app/current checkout or slug fallback targets another repository | Stable repo_target_id under project/config; REPO_TARGET_REQUIRED, REPO_TARGET_AMBIGUOUS, REPO_TARGET_FOREIGN or REPO_TARGET_STALE. |
| Split authority | GitHub label, BB Task, Markdown row or project file activates work | Canonical WorkItem and resolver; PROJECTION_DRIFT is visible and projections rebuild from canonical state. |
| Stale governorship | Old source/target process writes after a fence transition | Compare-and-swap epoch/token; GOVERNOR_EPOCH_STALE or PROJECT_FROZEN. |
| Missing governorship | A resolver or adapter proceeds when the canonical store is unavailable | Fail closed with GOVERNOR_UNAVAILABLE or CANONICAL_STORE_UNAVAILABLE. |
| Role succession race | Retired or non-head generation accepts a decision | Current RoleHead, active state, holder receipt and monotonic generation checks; ROLE_GENERATION_STALE. |
| Unqualified actor | Expired, contradictory or absent qualification satisfies a role or review gate | Immutable observations and derived eligibility; ROLE_UNQUALIFIED or CAPABILITY_UNKNOWN. |
| Duplicate writer | Two active writers share a project lane | One-writer-per-lane policy at dispatch; no runtime ceiling enforcement remains after the assignment-subsystem severance. |
| Requested/executed confusion | Requested profile is reported as actual execution | Separate Assignment and ExecutionAttempt; EXECUTION_PROFILE_UNKNOWN or EXECUTION_PROFILE_MISMATCH. |
| Dispatch ambiguity | Native spawn is acknowledged but start/terminal evidence is missing | DISPATCH_UNKNOWN; reconcile by native/idempotent identity and do not blind-retry. |
| Quiet worker failure | Worker dies, hangs or quota-fails without a terminal tell | Native lifecycle and terminal receipt required; FAILED or unresolved dispatch, never success by silence. |
| Connector bypass | Required external review is relabeled unavailable or inferred healthy from another repository | Separate policy/capability and exact-target fixture; CONNECTOR_REQUIRED_UNSATISFIED. |
| Review drift | Review or connector artifact covers an old candidate head | Exact-head terminal artifact and amendment invalidation; REVIEW_HEAD_STALE. |
| False success | Zero rows, empty loop, reaction, HTTP success or process presence is treated as proof | Every result names subject, mechanism, expected/attempted/verified counts and a negative case. |
| Dirty cleanup | Thread archival destroys unique work or ignored state | Separate destruction action with exact path, clean/disposable proof and recovery evidence; ENVIRONMENT_NOT_DISPOSABLE. |
| Migration mismatch | Counts match while keys, hashes, holds or evidence differ | Deterministic logical export, referential/equivalence checks and target non-writing state; IMPORT_EQUIVALENCE_FAILED. |
| Dual governance | Source and target each hold an active flag or projection can write around the fence | One shared ProjectGovernorship CAS guard consulted by every sanctioned mutator; SOURCE_FREEZE_UNPROVEN if canaries are incomplete. |
| Unmanaged activity | Raw BB thread or direct repository edit appears and is assumed authoritative | Record UNMANAGED_ACTIVITY; it owns no lane, role, review, release or closure until discarded or explicitly adopted. |
| Legacy authority manufacture | Imported created_by or accepted_by string becomes a new role | Preserve LegacyClaim evidence only; unresolved legacy authority cannot activate or close work. |
| Operator identity spoofing | Display name, checkout possession or thread ID is accepted as privileged actor | Hold privileged mutation until a proven BB-native authenticated receipt or explicit narrow operator decision exists. |
| Bootstrap Decision authority substitution | A plugin or governor actor authorizes a cross-project bootstrap Decision outside the operator-rooted source governorship | Only the exact immutable `operator_only` identity with project scope `{operation: "cross_project_bootstrap", sourceProjectId: <request project>, targetProjectId: <distinct target>, repoTargetId: null}` and options `{rootOfTrust: "host_local_operator"}` may use the exact verified plugin receipt recorded by the current source governorship head. Creation stores the source project, epoch, fence, actor receipt and integrity digest; disposition revalidates that same root and never switches it. |
| Interim receipt replay or phase splitting | One receipt authorizes a second mutation or a reserve/finalize adapter sequence | Exact one-request binding, atomic consumption, original-replay-only idempotency, and pre-adapter refusal for the three unsupported operations; OPERATOR_RECEIPT_REUSED, OPERATOR_RECEIPT_STALE or OPERATOR_RECEIPT_TWO_PHASE_UNSUPPORTED. |
| Derived actor standing identity | A plugin actor receipt is reused with another authorization or detached from its approver | Bootstrap-only atomic issuance, durable operator receipt linkage, exact linked-receipt check and host-issued retirement condition; ACTOR_RECEIPT_UNVERIFIED or OPERATOR_RECEIPT_STALE. |
| Authorized approver spoof/revocation | An unregistered, foreign, changed or revoked approver attests a privileged mutation | Exact project/approver/Decision/disposition registry row, exact current ten-class allowlist, caller-plugin check and active-current disposition check; AUTHORIZED_APPROVER_UNKNOWN, AUTHORIZED_APPROVER_INVALID or AUTHORIZED_APPROVER_REVOKED. |
| Projection drift | External state is used to mutate canonical state for convenience | Projection is rebuildable; canonical state changes only through governed import/adoption. |
| Cross-project inbox read or send | Ambient thread, checkout or missing project selects another project's message | Required registered `project_id`, exact sender-thread project comparison, and a project predicate on every message read and update. |
| Ghost reply | Platform send accepts a reply for a thread whose environment is gone | Require a ready project-exact environment and the exact matching post-send user-message event; persist and display delivery failure when either proof is absent. |
| Urgent notification loop | A repeated condition floods external notification channels | Suppress only an exact `(recipient, sender thread, severity, message text)` repeat inside 60 minutes; different content remains immediately notifiable. |

## Resolver invariants

Every canonical mutation supplies project_id, operation class, expected
governance epoch/token, config revision, typed actor, exact resource when
applicable, exact repository target when repository semantics exist, expected
resource revision and idempotency key.

The resolver rejects:

- unknown or stale project/config;
- missing, ambiguous, foreign or stale target;
- unavailable, frozen or stale governorship;
- retired, wrong or mismatched role;
- absent, expired or contradictory qualification;
- stale resource revision or conflicting idempotency reuse; and
- a writing-lane policy conflict at dispatch; no runtime occupied-lane refusal
  remains after the assignment-subsystem severance recorded in [issue #192](https://github.com/pixexid/bb-collab/issues/192).

It commits the aggregate change, append-only StateEvent, evidence references
and revision together or commits none. No projection, wrapper, retry helper or
shell exit-code conversion can override a typed refusal.

## Connector and review boundary

Connector policy is project configuration: required, optional or prohibited.
Observed capability is evidence: available, absent, degraded or unknown.

- Required plus available requires one valid connector artifact on the frozen
  head, independent local exact-head review and normal gates.
- Required plus absent, degraded or unknown blocks before merge.
- Optional plus any non-available state may use independent local review, but
  the state stays visibly unknown or degraded.
- Prohibited means repository material is not sent to the connector.

The connector pass is one-pass only for the frozen head and bounded,
adjudicated amendments. A material unrelated change, moved base, force-push
ambiguity, new high-risk surface or amendment-cap breach requires a new
review generation and required connector pass. Timeout and empty artifacts are
not passes.

## Environment and migration safety

Thread archival is not environment destruction. Destruction requires exact
project/repository/environment/path, no active or unresolved assignment,
clean/disposable proof against the correct candidate, unique-state checks,
recovery evidence and current revisions. A failed proof leaves state untouched
where BB permits.

Role qualification accepts a derived path only for a ready BB-native
`managed-worktree` whose project and host resolve to exactly one canonical
source. The canonical source path and derived environment path remain separate
evidence; unmanaged, ephemeral, foreign or ambiguous contexts fail closed,
except the exact v17 director generation-1 holder/environment/source triple
for its bounded qualification recording and receipt-gated first-generation
creation. That exception admits neither writing nor later generations.

Cutover has a no-writer interval:

1. prepare target in shadow/read-only mode;
2. instrument every sanctioned source mutator;
3. quiesce writers, reviewers, releases and unresolved dispatches;
4. atomically freeze source and rotate the token;
5. export deterministically and import idempotently;
6. prove keys, hashes, heads, holds, evidence and projections equivalent;
7. atomically activate target with a new epoch/token;
8. exercise one ordinary lane; and
9. retire the source while preserving read-only evidence.

Before any target mutation, rollback is safe only with unchanged source/export
digests, imported and target mutation sequences equal, no target-created
canonical or external projection mutation, and passing source canaries.
After target mutation, recovery is fix-forward/read-only unless a separate
lossless reverse adapter has been fixture-tested.

## Enforcement ceiling

The plugin can make harness-era authority impossible in new canonical records
and sanctioned mutations. It cannot physically veto every direct Git
operation, filesystem edit, raw BB thread, full-trust plugin action or
administrator database edit on a machine the operator controls. Native
activity that bypasses the guard is unmanaged evidence, not authority.

Stronger physical prevention requires an upstream BB spawn-veto capability,
operating-system isolation or repository permissions outside bb-collab v1.
The contract must state this ceiling rather than claiming that observation is
prevention.
