# bb-collab roadmap

The roadmap is dependency-ordered. Each step has an observable exit
condition; a later step must not smuggle authority into an earlier one.
[ADR 0001](adr/0001-founding-contract.md) is the governing contract and
[the import manifest](import-manifest.md) is the surviving issue ledger.
The detailed 40-issue source disposition is in the
[llm-collab migration ledger](llm-collab-migration-ledger.md).

## Founding documentation

1. Freeze the contract, threat model, import manifest and evidence links.
   Exit: one documentation commit from the exact founding base; all hashes,
   source links and Markdown checks pass; no implementation scaffolding exists.

## v1 dependency sequence

2. **Plugin, storage and migration foundation.** Establish one BB plugin
   database, transactional migrations, foreign keys, append-only events,
   deterministic IDs, optimistic revisions, idempotency, verified backup and
   deterministic logical export. Prove plugin/store failure leaves governed
   mutations read-only.

3. **Project configuration and repository targets.** Add immutable
   ProjectConfigRevision and ProjectConfigHead plus stable RepositoryTarget
   IDs, exact BB project/source/host placement, default branches, secret
   references and project-extension surfaces. Prove there is no default
   repository target.

4. **Conformance doctor and explicit apply.** Provide a read-only default
   command and explicit idempotent apply/verify mode. Validate exact BB/plugin
   versions, project/config identity, repository targets, dependencies,
   GitHub access when configured, native event observation, managed worktree
   readiness, role requirements, review/release surfaces and connector
   evidence. Prove expected/attempted/verified counts, including zero work.

5. **Project governorship and resolver.** Add source_active, frozen,
   target_active and retired states; monotonic epoch, compare-and-swap token,
   typed actor/resource resolution, operation classes, config revisions,
   idempotency and typed refusal families. Prove stale epoch, wrong project,
   wrong repository and unavailable-store writes fail without mutation.

6. **Canonical WorkItem and first projection.** Define WorkItem lifecycle and
   ExternalWorkRef. Create GitHub Issues as the first one-way projection,
   enforce transitions and holds, and rebuild projection drift from canonical
   state. External issue/task state cannot activate work.

7. **Role generations and qualification.** Implement manual orchestrator and
   reviewer succession, holder ExecutionAttempt binding, executed-profile
   digests, current eligibility, expiry and stale/retired-generation refusal.
   Keep leases, heartbeat expiry and automatic failover deferred.

8. **Assignment and ExecutionAttempt.** Enforce one writer per lane and the
   project ceiling of two, exact branch/base/candidate semantics, frozen-brief
   digest, native BB spawn/attach, actual profile receipt, isolated
   environment and terminal DONE|BLOCKED report. Reconcile ambiguous dispatch
   as DISPATCH_UNKNOWN; do not blind-retry.

9. **Decision, disposition and evidence.** Add typed operator/role actors,
   immutable Decision identity, append-only dispositions, helper/Pro advisory
   relations, holds, conditions, revert and delegated-action receipts. Import
   legacy authority strings as evidence only.

10. **Review, release and environment safety.** Require final independent
   local exact-head review, connector policy/capability truth table, bounded
   one-pass amendments, exact repository-target release evidence, literal
   aggregate verification, clean/disposable proof and exact cleanup blockers.

11. **Migration and cutover.** Build deterministic export/import, source
   mutator inventory, shared governorship guard, freeze canaries, no-writer
   interval, equivalence proof, target activation, routine exercise and
   source retirement. Roll back only before target mutation; after a target
   write, fix forward unless a lossless reverse adapter is separately tested.

12. **Adversarial conformance fixtures.** Every fixture must fail without
   mutation and name the mechanism: wrong project, wrong repository, stale
   config, stale role generation, stale epoch/token, duplicate writer,
   missing execution receipt, connector silence, moved review head, dirty
   environment, zero-work provisioning, projection drift, unmanaged activity,
   import/hash mismatch and canonical-store unavailability.

13. **First-adopter lane.** Cut over one quiet standard one- or two-repository
   project. Run one ordinary non-spend, non-production-migration WorkItem
   through assignment, execution, exact-head review, release evidence and
   closure. Measure operator time and record every project-local extension gap.

14. **Post-v1 only after evidence.** Open work for capacity/failover, leases,
   custom transport, automated subagents, BB Tasks projection, broader
   qualification campaigns, dashboards, multi-server availability or reverse
   migration only when the first-adopter evidence shows a concrete gap.

## Immediate migration holds

The next cutover chain is [#5 / get-bb/bb #1541 operator receipt](https://github.com/get-bb/bb/issues/1541),
[#29 MigrationRun and one-governor cutover](https://github.com/pixexid/bb-collab/issues/29),
[#30 native managed-worktree and candidate attach](https://github.com/pixexid/bb-collab/issues/30),
and [#31 adversarial conformance and first adopter](https://github.com/pixexid/bb-collab/issues/31).
[get-bb/bb #1543](https://github.com/get-bb/bb/issues/1543) is a separate native
GitHub state-change wake continuation, not cutover authority.

P4 plugin profile, P5 renewable leases, P6 capacity/failover, and P7 optional
transport remain named post-v1 holds; they are not issue-spam prerequisites.

## Executable adoption target

The release gate is:

- one standard one- or two-repository project;
- no more than four operator hours to one routine closed lane;
- one versioned project extension and explicit secret references;
- no shared bb-collab code edit, manual database edit, hand-built role file,
  bulk label loop, watcher process or one-off spawn exception;
- read-only doctor, explicit apply and post-apply doctor converge
  idempotently; and
- wrong project, wrong repository, stale epoch and zero-work false-success
  cases return typed reasons with no side effects.

Product-specific priorities, browser/database/deployment commands, labels,
connector selections, operator holds, ports, runtime URLs and release
surfaces belong in project extensions. They do not expand the founding core.
