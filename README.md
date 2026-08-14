# bb-collab

BB-native project governance, work lifecycle, and collaboration runtime.

## Sidebar thread list

The optional `bb-collab thread list` provider groups live threads by stable
project identity and keeps custom per-thread state in plugin storage. Select it
in Settings > Appearance > Sidebar. The built-in list remains the default and
retains the Lane 1 thread-row pulse fallback; the host continues to render
new-thread, search, navigation rows, and the footer.

## Founding status

Issue 1 freezes the contract and v1 boundary before implementation begins.
The repository now contains the implemented foundation through contract v7/schema v10: a
single SQLite store with migrations, resolver, state-event and
mutation-receipt, deterministic export, and read-only doctor seams, plus
WorkItem/ExternalWorkRef, role qualification/RoleGeneration,
Assignment/ExecutionAttempt, and typed Decision/EvidenceArtifact/DecisionEvidence
foundations. Production RPC/CLI apply require an exact one-request interim
operator receipt bound to project, operation, exact candidate head,
idempotency key, and request digest; it is consumed atomically and invalid,
stale, retired, mismatched, or reused receipts refuse before any write. The
receipt has no local expiry or revocation: it retires only on the host-issued
`get-bb/bb#1541` condition, and stale means an exact binding mismatch. A
confirmed bootstrap operator receipt atomically derives a verified
`plugin/bb-collab` actor receipt linked to that exact operator receipt; the
derived actor is not standing authority and apply must provide the same linked
operator receipt. An adopted `operator_only` Decision registers the exact
`orchestrator:bb-collab` approver and six ratified derived mutation classes,
including `work_item_create`;
the `approverAttestation` RPC issues a fresh exact-bound receipt and verified
plugin actor without `requestInput`. Operator revocation or change marks that
registry unusable. Human confirmation remains only at the authorization and
revocation boundary; the interim registry and receipts retain the upstream
host-issued `get-bb/bb#1541` retirement condition. Live RPC and CLI role
mutations read exact BB thread, event, environment, project, host and version
facts through the existing `RoleFactReader` seam before issuing
`qualification_observation_record` or `role_generation_succession`; missing or
foreign facts refuse before write.
`github_issue_projection`, `assignment_dispatch`, and `assignment_reconcile`
reserve/finalize operations refuse before the adapter under this one-request
seam. The derived actor path is limited to bootstrap, operator_only Decision
create/adopted disposition, migration_prepare, and migration_step; role-based
and review Decisions remain role-bound. The plugin has not been installed, reloaded, or activated against live
project authority.

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
   eligibility evidence needed for the orchestrator and reviewer roles.
7. One sanctioned native BB assignment path with separate Assignment and
   ExecutionAttempt records, exact executed-profile receipts, isolated
   environments and terminal reports.
8. Decisions, dispositions, evidence artifacts and operator holds, with
   consults explicitly advisory.
9. Exact-head review, release and environment-safety gates with
   capability-aware connector handling.
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
