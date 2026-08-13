# Import manifest and surviving issue ledger

This manifest records what is carried from the llm-collab evidence into
bb-collab. It preserves invariants and evidence, not legacy implementation,
mutable Markdown authority, watcher history or harness identities.

The controlling decision is
[ADR 0001](adr/0001-founding-contract.md). The approved public evidence is the
[founding gist](https://gist.github.com/pixexid/77c7ac47afc27a63a147159195ba56b7).
The llm-collab source fence is
[f988d9711d3778f751e4ec0e32ebbf7b0893c80f](https://github.com/pixexid/llm-collab/tree/f988d9711d3778f751e4ec0e32ebbf7b0893c80f).

## Import boundary

The logical export is versioned and deterministic:

- manifest.json: schema/runtime identity, project, source and target
  governorship, config revision, snapshot/event sequence, counts and root
  digests;
- stable-order records.ndjson: canonical entities and events;
- artifact index: content digests and durable references, with bytes bundled
  only when portability requires them; and
- checksums.sha256: digest coverage for every emitted file.

A raw database copy may be a backup but is not the migration contract.

Import is idempotent by source_system, project_id and source_export_digest.
The target remains non-writing until referential integrity, exact key and
hash equivalence, repository heads, holds, evidence, projection rebuild and
read-only doctor checks pass.

The migration sequence is prepare, source instrumentation, quiesce, atomic
freeze, deterministic export, deterministic import, equivalence, atomic target
activation, routine exercise and source retirement. The source and target share
one compare-and-swap governorship epoch/token. There is no dual queue, mirror,
fallback write path or writer during the frozen interval.

Legacy data is imported as facts and evidence:

- retain original bytes or durable locations, content digest, source
  runtime/version, project and import time;
- preserve literal fields such as created_by, refined_by, accepted_by and
  release_gate_agent as LegacyClaim evidence;
- never create a role generation from a harness or provider string;
- retain legacy acceptance overrides as task-scoped evidence, not authority;
- retain terminal records as terminal snapshots;
- keep nonterminal records read-only until an active bb-collab role or
  authenticated operator issues an explicit adoption disposition; and
- mark ambiguous or incomplete authority unresolved.

## Universal clause ledger

| Clause | Disposition | Surviving bb-collab contract |
| --- | --- | --- |
| 1. Mechanism-first philosophy | Ratify | Claim strength cannot exceed signal strength. Every success names its subject, mechanism and discriminating negative case. |
| 2. Exact project/repository boundaries | Ratify | Stable project/config/repository IDs; exact target when repository semantics exist; no checkout, ordering or slug fallback. |
| 3. Cached-worker contract bump test | Ratify | One version bump, consumer enumeration, stale refuse or reread proof and rollout receipt. Version text alone is not migration. |
| 4. Issue/task state model | Amend | Canonical WorkItem owns lifecycle. GitHub state labels, epic markers and parked labels are adapter rules; onboarding maps and verifies them mechanically. |
| 5. Lane discipline | Amend | One writer per lane; hard project ceiling two, lowerable but not raisable. Read-only work is assigned and isolated without consuming the cap. |
| 6. Truthful planning/assignment/authority/release provenance | Ratify | Split Assignment and ExecutionAttempt, typed actor, exact target, revision and resolver; no harness fallback. |
| 7. Sanctioned delegation | Amend | One native BB path, exact environment, frozen-brief digest and terminal receipt. Permission and visibility are explicit; automated delegation remains depth-one/draft-only and post-v1. |
| 8. Review/release lifecycle | Amend | Exact-head local review is universal; external connector policy is separate from capability; amended heads invalidate one-pass evidence; release and cleanup bind exact target/head. |
| 9. Current governance | Ratify | Project orchestrator owns ordinary project decisions; helpers and Pro reads are advisory; operator-only classes remain explicit. |
| 10. Qualification/evaluation discipline | Ratify | Immutable observations are keyed by executed-profile, BB/runtime and fixture context; eligibility is derived and replaceable. |
| 11. Shared-checkout/environment safety | Ratify | Archive and destruction are distinct; destruction requires exact path, clean/disposable proof, unique-state check and recovery evidence. |
| 12. One-governor migration | Amend | Shared CAS fence, source mutator inventory/canaries, no-writer freeze, deterministic equivalence and fix-forward after target mutation. |
| 13. Onboarding and conformance | Add | Read-only doctor plus explicit idempotent apply/verify validates exact BB/plugin, project, targets, dependencies, projections, workers, worktrees, roles, review/release surfaces and connector evidence. Zero work is not success without expected/attempted/verified proof. |

## Issue disposition ledger

The ledger migrates the surviving requirement, evidence or probe. It does not
copy an issue body or its implementation assumptions.

| Issue | Disposition | bb-collab treatment |
| --- | --- | --- |
| GH-784 | Migrate | Founding worker/authority provenance becomes Project, Governorship, RoleGeneration, WorkItem, Assignment, ExecutionAttempt, Decision and Evidence keys. |
| GH-800 + GH-812 | Fold into GH-800 | One exact repository-target/candidate selector requirement. Fold GH-812 read-only candidate acceptance criteria into it; do not create two successor seams. |
| GH-787 | Split | Monotonic project governorship and manual role-generation succession are v1. Renewable leases, expiry and automatic failover are post-v1. |
| GH-788, GH-789, GH-790 | Migrate post-v1 | Preserve capacity/failover, native role wake/transport and plugin-profile observations as later requirements; they do not block founding. |
| GH-755 + GH-822 | Merge into generic qualification | Preserve observations, fixtures and open questions in QualificationObservation and EligibilityProjection; do not create model-branded founding issues. |
| GH-159 | Close after proof | Close as obsolete only after stale/forged activation is covered by governorship, role-generation and mutation-resolver tests. |
| GH-630 | Retain probes | Close the monolithic plugin plan only after preserving native capability probes as ADR/conformance fixtures. Observation without veto is a design constraint. |
| GH-823 | Migrate invariant | Carry actionable mechanism/detail diagnostics; delete marker-watcher implementation rather than porting it. |
| GH-718 | Probe first | Run one cheap current-version BB compatibility probe before encoding any workaround. |
| GH-815 | Migrate | Preflight targets the task's exact managed environment and repository target, never a parked canonical checkout. |
| GH-820 | Migrate | Release evidence names the task's exact repository target and candidate. |
| GH-818 | Migrate | Cleanup output names exact blocking rows and dispositions; no empty-loop success. |
| GH-813 | Absorb | Encode the current governance and brief behavior in the canonical contract; do not create another cached prose contract. |
| GH-824 | Evidence only | Treat the in-flight legacy review fix as source-history context, not a new bb-collab authority or implementation dependency. |

All other historical issue/task material remains legacy evidence, is archived by
digest when needed, or stays with llm-collab for projects not yet cut over.

## Leave-behind list

Do not import or recreate:

- mutable Markdown task files as authority;
- legacy queues, inboxes, ACK/dedupe transports, pointer wakes, marker
  watchers or restart-local ownership;
- Claude app/AX/session identities, rings, harness-named roles or a standing
  supervisor;
- hard-coded provider identity, canonical checkout or single github.repo;
- raw BB thread creation as a sanctioned assignment path;
- direct GitHub label mutation as activation;
- BB Tasks, GitHub Projects or GitHub labels as canonical state;
- archiving the last thread as environment destruction;
- a second role store, resolver, assignment ledger, decision concept or
  migration registry;
- a generic bus, daemon, dashboard, automated failover/capacity router or
  workflow/fan-out engine;
- universal full-permission inference;
- a physical raw-BB/admin/Git/filesystem veto claim; or
- generic post-write reverse migration without a lossless fixture-tested
  adapter.

## Import and adoption evidence

Before target activation, the MigrationRun must include:

- source runtime/contract and target plugin/schema identity;
- project/config/repository-target records and exact heads;
- governance freeze receipt and source snapshot/event sequence;
- active role heads and nonretired generations needed for evidence;
- nonterminal assignments and attempts with actual state;
- active decisions, holds, dispositions and qualifications;
- exact repository heads and review/release evidence;
- external references, projection cursors and idempotency keys;
- export/import/equivalence digests and recovery artifacts; and
- source mutator inventory plus one refusal canary per expected mutation class.

The first-adopter criterion is a standard one- or two-repository project reaching
one routine closed lane in at most four operator hours, with no shared code
edit, manual database edit, bulk-label loop, watcher or spawn exception.
Wrong-project, wrong-repository, stale-epoch and zero-work provisioning
fixtures must fail with typed reasons and no mutation.

The attachment hashes verified for this founding lane are:

- founder adjudication:
  9e45d19f489b3bbcde16325f6a4ad57fac70ee67a11ac2ef1eac0f35b2f99fab;
- GPT-5 Pro verdict:
  6a161e84106126cd8fe1ad949f450a6adc54853e0d844e0c1dc4461bc4a77447.

Those local attachments are run evidence. The public gist and source-fence
links at the top are the durable references.
