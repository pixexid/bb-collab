# bb-collab

BB-native project governance, work lifecycle, and collaboration runtime.

## Deployed artifact check

After `bb plugin reload bb-collab`, run
`npm run --silent check:deployed-dist` in the deployed checkout. It is silent
when tracked `dist/` matches the checkout's commit; otherwise it exits nonzero,
names every divergent artifact, and warns that the running plugin no longer
matches that commit. This detects divergence after reload; it does not stop bb
from rebuilding the frontend first.

## Sidebar thread list

The optional `bb-collab thread list` provider groups live threads by stable
project identity and keeps custom per-thread state in plugin storage. Select it
in Settings > Appearance > Sidebar. The built-in list remains the default and
retains the Lane 1 thread-row pulse fallback; the host continues to render
new-thread, search, navigation rows, and the footer.

## Operator inbox

The Inbox nav panel is a durable, model-free message surface for `operator` and
`supervisor` recipients. Seats send with the `send_to_operator` tool or
`bb collab send-to-operator`; host-side pickup is available through the panel
or `bb collab inbox`. Every send and read requires an exact registered project
id. Urgent messages dispatch through the installed desktop and phone
notification plugins. Exact repeats of recipient, sender thread, severity, and
message text are suppressed for 60 minutes; different content fires
immediately. Replies use platform steer and count as delivered only after the
matching input event appears in the sender thread; failures remain visible and
retryable in Inbox.

## Founding status

Issue 1 freezes the contract and v1 boundary before implementation begins.
The repository now contains the implemented foundation through contract v20/schema v12: a
single SQLite store with migrations, resolver, state-event and
mutation-receipt, deterministic export, and read-only doctor seams, plus
WorkItem/ExternalWorkRef, role qualification/RoleGeneration,
Assignment/ExecutionAttempt, and typed Decision/EvidenceArtifact/DecisionEvidence
foundations. The four logical roles are director, project-orchestrator, worker,
and independent-reviewer. Only `director-seat` carries one named receipt-gated
standby profile with no authority or traffic; its provider must differ from the
director holder. Production RPC/CLI apply require an exact one-request interim
operator receipt bound to project, operation, exact candidate head,
idempotency key, and request digest; it is consumed atomically and invalid,
stale, retired, mismatched, or reused receipts refuse before any write. The
receipt has no local expiry or revocation: it retires only on the host-issued
`get-bb/bb#1541` condition, and stale means an exact binding mismatch. A
confirmed bootstrap operator receipt atomically derives a verified
`plugin/bb-collab` actor receipt linked to that exact operator receipt; the
derived actor is not standing authority and apply must provide the same linked
operator receipt. `config_revision` additionally requires the exact current
plugin actor bound to that receipt and its explicit `console` or `attestation`
issuance provenance; a verified but unlinked or role actor, and a fresh legacy
NULL-provenance apply, refuse before any write. An exact replay already bound
to a committed mutation returns its recorded outcome without revalidating the
consumed receipt provenance. An adopted `operator_only` Decision registers the exact
`orchestrator:bb-collab` approver and ten ratified derived mutation classes,
including `config_revision` for the existing canonical mutation that replaces
the full immutable project configuration and its mapped targets, including
`roleRequirements` provisioning,
`work_item_create`, `work_item_transition`, `qualification_observation_record`, and
`role_generation_succession`;
the `approverAttestation` RPC issues a fresh exact-bound receipt and verified
plugin actor without `requestInput`. Operator revocation or change marks that
registry unusable. Human confirmation remains only at the authorization and
revocation boundary; the interim registry and receipts retain the upstream
host-issued `get-bb/bb#1541` retirement condition. Live RPC and CLI role
mutations read exact BB thread, event, environment, project, host and version
facts through the existing `RoleFactReader` seam before issuing
`qualification_observation_record` or `role_generation_succession`; missing or
foreign facts refuse before write. A ready native managed worktree may have a
derived path distinct from its canonical source; exact project/host/source
resolution retains both paths and still refuses unmanaged or ephemeral contexts,
except for the exact director generation-1 qualification-and-creation exemption below.
`github_issue_projection`, `assignment_dispatch`, and `assignment_reconcile`
reserve/finalize operations refuse before the adapter under this one-request
seam. The derived actor path is limited to bootstrap, `config_revision` for
that full project-configuration/target replacement, operator_only Decision
create/adopted disposition, work_item_create, work_item_transition,
qualification_observation_record, role_generation_succession, migration_prepare,
and migration_step; role-based
and review Decisions remain role-bound. The plugin has been activated against live
project authority; reload evidence is actor-recorded.

Historical contract v11 was a contract-only role-capacity amendment: `roleRequirements`
admitted at most three logical roles. `project-orchestrator` was project-scoped;
`worker` and `independent-reviewer` require the exact repository target used by
canonical WorkItem writes. All three retain executed-profile qualification and
the v10 receipt/approver bindings are unchanged. Contract v12 is a contract-only
allowlist amendment that adds `work_item_transition`; schema and migrations remain
unchanged, and the existing receipt, actor, config, governor and resource guards
remain required. Contract v13 replaces the founding hard-2 writing-lane ceiling
with the explicit `extensions.bbCollab.writingLaneCeiling` per-orchestrator dial,
The dial remains canonical configuration and is validated when configuration is
accepted; seats honour it as policy at dispatch time, but no runtime path gates
admission or queue startability against it. Enforcement ended with the
assignment-subsystem severance recorded in [issue #192](https://github.com/pixexid/bb-collab/issues/192).
Read-only reviews and probes do not consume the writing cap.

Historical contract v13 added the schema-backed named standby profile for new
project-orchestrator generations. The standby provider had to differ from the
executed holder and the standby had no authority or traffic; existing receipt,
qualification, and succession guards remain unchanged.

Historical contract v14 added the bounded `director-seat` role-requirement amendment on
the existing `project-orchestrator` seat. It fixes the primary executed
profile to `pi/kimi-coding/k3/high` with explicit full/default/visible fields,
the alternate standby to Opus-medium, retains managed-worktree isolation, and
gives the seat zero writing-lane capacity. The unmanaged epoch-2 holder
`thr_gsb7m77ciz` on `env_3znzsxb7ce` is grandfathered service evidence, not a
generation-3 holder; no RoleGeneration row is fabricated. A future successor
must pass a dry-run/preflight and be recorded by the receipt-gated succession
apply before taking the seat.

The historical contract-v9 eight-class registry was accepted only during the
one-release v9-to-v10 re-adoption. Historical contract v15 left the exact
ten-class allowlist unchanged; the already-bounded v11 nine-class repair
remains readable but still refuses `work_item_transition`. Malformed, reordered,
subset, extra, v9, and other arbitrary sets remain invalid. This is a contract
bump for the current-generation director-seat exemption: cached consumers must
reread v15 or refuse v14, with durable rollout evidence; schema and migrations
remain unchanged.

Historical contract v15 added only the current-generation environment exemption required to
record the grandfathered epoch-2 director qualification: generation 2, holder
`thr_gsb7m77ciz`, environment `env_3znzsxb7ce`, and source `src_x8veidmpik`.
It is valid only while that exact role head and holder execution evidence remain
current, only for qualification recording, and never for writing admission or
succession. Every future generation requires a managed isolated worktree.

Historical contract v16 rejected a native thread whose title or title fallback marked it as
a witness before it can supply role qualification or succession holder facts.
This bounded eligibility gate preserved the existing role, generation, native
environment/source, and executed-profile checks; schema and migrations remained
unchanged, and cached consumers reread v16 or refused v15.

Contract v17 supersedes the v14/v15 director placement and exemption:
`director-seat` is the only project-scoped `director` requirement, while
project-orchestrator is a separate project-scoped role and worker and
independent-reviewer remain repository-target scoped. The director's exact
Pi/Kimi primary profile, Opus-medium standby, and zero writing-lane capacity
are unchanged. Only director generation 1 for holder `thr_gsb7m77ciz`,
environment `env_3znzsxb7ce`, and source `src_x8veidmpik` may use the bounded
unmanaged qualification-and-creation exemption, receipt-gated with no
predecessor and no existing director head; later director generations require
the existing managed isolated worktree checks. All four cached consumers must
reread v17 or refuse v16. Rollout success is reported only from a persisted,
identity-validated receipt with expected=attempted=verified=4; absent or
invalid evidence is unknown and fail-closed.

The ratified evidence-only MigrationRun shape records the llm-collab fence
`f988d9711d3778f751e4ec0e32ebbf7b0893c80f` at resource revision 4 and merged
main `0686d34` as sorted, hashed, explicitly non-canonical source evidence.
The manifest is bounded before write; durable evidence retains only its digest
and `sourceExportKind`. It proves canonical import zero-work and preserves the
historical archive read-only; no source-CAS event ceiling or source retirement
is fabricated.

Pre-target rollback from prepared, frozen, exported or imported restores
`source_active`. Once equivalent, an evidence-only run may close through the
bounded rollback disposition: exact recovery proof and source/frozen-to-target
runtime binding rotate the governor directly to `target_active` and record
release evidence; post-target fix-forward semantics are unchanged.
This resolver evidence does not make live cutover ready: exact live project
configuration, repository target, shared source guard, mutator canaries and
operator-gated runtime identity remain required, and this change performs no
live install, reload or mutation.

The founding decision is an **adopt with amendments** disposition of the
operator-backed review. bb-collab is a public BB-native successor to
llm-collab: distill the surviving invariants; do not fork its history or
implementation.

- [Issue 1](https://github.com/pixexid/bb-collab/issues/1) is the acceptance
  record.
- [ADR 0001](docs/adr/0001-founding-contract.md) is the complete decision.
- [Threat model](docs/threat-model.md) defines the trust and enforcement
  ceiling.
- [Import manifest](docs/import-manifest.md) records surviving clauses and
  issue dispositions.
- [Roadmap](docs/roadmap.md) gives the dependency order and adoption gate.

Evidence is public and durable:
[approved founding evidence gist](https://gist.github.com/pixexid/77c7ac47afc27a63a147159195ba56b7)
and the
[llm-collab source fence](https://github.com/pixexid/llm-collab/tree/f988d9711d3778f751e4ec0e32ebbf7b0893c80f).
The attached adjudication and Pro verdict are provenance inputs, not
independent authority stores. No license is inferred from the unlicensed
predecessor.

## Canonical boundary

- The bb-collab plugin SQLite database owns canonical governance and work
  state.
- BB core owns native project, source, host, environment, thread, provider and
  event facts.
- GitHub Issues, BB Tasks, Markdown and project files are projection,
  configuration or evidence surfaces only.

The plugin governs sanctioned canonical mutations. It cannot physically veto
raw BB, administrator, Git or filesystem activity; unmanaged activity gains no
canonical authority merely by being observed.

Review is tiered by touched surface: Tier A requires independent exact-head
cold review before merge, Tier B merges on local verification and CI with cold
review post-merge in parallel, and Tier C uses local verification and CI only.
Every PR body declares its tier; wrong-tiering is a review finding.

## v1 boundary

The first release is complete only when it can provide:

1. One BB plugin database with transactional storage, migrations, backup and
   deterministic logical export.
2. Immutable project-config revisions and exact stable repository targets.
3. A read-only conformance doctor and explicit idempotent apply/verify mode.
4. Project governorship with one compare-and-swap epoch/fence and one
   versioned mutation resolver.
5. A canonical WorkItem lifecycle and GitHub Issues as the first projection.
6. Role generations, manual succession and the minimum qualification and
   eligibility evidence needed for the director, project-orchestrator, worker
   and independent-reviewer roles; only director generation 1 may use the
   exact receipt-gated unmanaged qualification-and-creation exception.
7. One sanctioned native BB assignment path with separate Assignment and
   ExecutionAttempt records, exact executed-profile receipts, isolated
   environments and terminal reports.
8. Decisions, dispositions, evidence artifacts and operator holds, with
   consults explicitly advisory.
9. Tiered review, release and environment-safety gates with Tier-A exact-head
   review and capability-aware connector handling.
10. Deterministic source freeze, export, import, equivalence and one-governor
    activation.
11. One adversarial first-adopter conformance lane through routine closure.

No task or spawn authority implementation starts before storage, exact target,
conformance, governorship and resolver seams exist.

## Explicit non-goals for v1

- Automatic leases, heartbeat election, failover or provider-capacity routing.
- A custom bus, inbox, ACK/dedupe transport or watcher fleet.
- Automated subagent spawning, generalized delegation trees or depth greater
  than one.
- A generic workflow/fan-out engine, dashboard or plugin-profile control
  plane.
- BB Tasks, GitHub labels or GitHub Projects as canonical state.
- Model-branded qualification projects, provider price/quota brokerage or
  autonomous model selection.
- Multi-server active-active authority.
- Universal browser, database, deployment or product automation.
- Full replay of legacy chats, inboxes, pointer wakes, watchers or mutable
  task files.
- Standing supervisors, cross-project peer authority, Fable-specific routing
  or harness-named roles.
- Invisible full-permission defaults.
- A physical veto over raw BB, admin, Git or filesystem activity.
- Generic post-write reverse migration without a lossless fixture-tested
  adapter.

## Repository layout

| Path | Contract |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Contract version, canonical boundary and worker/review obligations. |
| [docs/adr/0001-founding-contract.md](docs/adr/0001-founding-contract.md) | Complete adjudicated schema, authority, failure and cutover decision. |
| [docs/threat-model.md](docs/threat-model.md) | Trust boundaries, threats, controls and enforcement ceiling. |
| [docs/import-manifest.md](docs/import-manifest.md) | Surviving llm-collab clauses, issue ledger and migration rules. |
| [docs/roadmap.md](docs/roadmap.md) | Dependency-ordered implementation and adoption evidence. |

## Dependency sequence

Founding work proceeds in this order: contract and source evidence; plugin
storage/export; project configuration and repository targets; conformance
doctor/apply; project governorship and resolver; WorkItem and GitHub
projection; role generations and qualification; assignment and execution;
decision/disposition/evidence; review, release and environment safety;
migration/cutover; adversarial fixtures; one quiet first-adopter lane.

## Adoption target

A standard one- or two-repository project must reach one routine closed lane in
at most four operator hours, without shared code edits, manual database edits,
manual label loops, watcher processes or one-off spawn exceptions. Doctor,
explicit apply and post-apply doctor must converge idempotently, and wrong
project, wrong repository, stale epoch and zero-work false-success fixtures
must fail with typed reasons and no mutation.
