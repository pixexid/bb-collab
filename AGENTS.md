# bb-collab repository contract

CONTRACT_VERSION: 20

This repository contains the founding contract and the implemented foundation
through contract v20/schema v12: a single SQLite store with migrations, resolver,
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
the same host-issued `get-bb/bb#1541` condition.
Operator receipts record explicit `issuance_provenance`: new console receipts
are `console` and authorized-approver receipts are `attestation`; provenance is
never inferred from approver columns or a digest shape. A fresh apply with a
legacy NULL marker refuses, while an exact authorized replay of its already
committed mutation returns the recorded result without revalidating consumed
receipt provenance. Historical operator-receipt mutation is dead letter: no
historical receipt row is modified.
The GH-145 evidence capture from `bb plugin logs bb-collab` recorded 96 plugin load events from 2026-08-13T22:20:14Z onward, including 69 before 2026-08-15; the command is a rolling surface, so these are the captured historical counts. `activated against live project authority` has no log-readable definition and is restated precisely: 2026-08-15 is the actor-recorded date of the resolver-wiring activation (operator-authorized console exception), not the first load. The plugin was reloaded at 2026-08-16T14:06:56-0700 by the sentinel under supervisor authorization (bb plugin reload bb-collab) against merge dff355c3d203 (PR #121, contract v17 director role split), with an earlier same-day reload by the director seat (thr_gsb7m77ciz); the plugin-log load event at 2026-08-16T21:06:57.608Z corroborates the sentinel reload at the adjacent one-second timestamp. This sentence previously stated the plugin had never been installed, reloaded, or activated (inaccurate from 2026-08-15, uncorrected for approximately one day) and also stated that bb records no reload history; that was false — the plugin-log artifact is reload/load history. Reload authorization and context remain actor-recorded, and a load log proves only that a load happened, never what code loaded: any future reload claim must correlate the load-event timestamp against the checkout SHA and an independent resolver read-back. The complete decision is in
[ADR 0001](docs/adr/0001-founding-contract.md); the threat boundary is in
[the threat model](docs/threat-model.md); import and issue disposition are in
[the import manifest](docs/import-manifest.md); and dependency order is in
[the roadmap](docs/roadmap.md).

The role requirement seam admits exactly four logical roles: director and
project-orchestrator are project-scoped, while worker and independent-reviewer
require an exact repository target; each requirement binds an executed-profile
qualification. The director role is reserved for `director-seat`, has zero
writing-lane capacity, and alone carries the exact standby profile.

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

Contract v20/schema v12 requires exactly four production cached consumers: the
registered RPC `doctor` handler, the CLI `doctor` dispatcher, and the two named
production replay/new-apply provenance validations. Each rereads v20; the
consumed legacy replay returns its recorded `OK` outcome and a fresh NULL or
unknown provenance apply refuses with `OPERATOR_RECEIPT_INVALID`; expected,
attempted, and verified must all be 4. The v20 receipt is the only current
receipt: missing or v19 receipt evidence is unknown and fail-closed, with no
automatic v19 receipt migration
or write. The replay consumer requires a read-only observed chain from the
consumed legacy receipt through its matching mutation receipt and StateEvent;
without it, rollout refuses rather than synthesizing success.
An adopted operator_only Decision registers approverId=orchestrator:bb-collab
with the exact ten derived mutation classes, including config_revision,
work_item_create, work_item_transition and
the two existing role mutation classes. Attestation has no requestInput
interaction and atomically creates the same exact-bound receipt plus verified
plugin actor; operator revocation/change marks the registry unusable. The
historical contract-v9 eight-class registry was accepted only during the
one-release v9-to-v10 re-adoption. Historical contract v15 left the exact
ten-class allowlist unchanged; the already-bounded v11 nine-class repair
remains readable for authority maintenance, but does not authorize
`work_item_transition`. Malformed, reordered, subset, extra, v9, or other
arbitrary sets refuse at attestation and apply. The v17 change was a semantic
contract bump for the director/orchestrator split: `CONTRACT_VERSION` and
`contractDigest` change; `SCHEMA_VERSION`, schemaDigest and migrations remain
unchanged, and all four cached consumers emit a durable reread/refusal rollout
receipt. `director-seat` is the only `director` requirement, requires the exact
`pi/kimi-coding/k3/high` primary profile and exact Opus-medium standby, and has
zero writing-lane capacity. Only director generation 1 / holder
`thr_gsb7m77ciz` / environment `env_3znzsxb7ce` / source `src_x8veidmpik` may
record its qualification and create director generation 1 from the approved
unmanaged canonical environment.
Every later director generation requires the existing managed, isolated
worktree and exact source/environment checks; the exemption is not general,
cannot admit writing, and future succession remains receipt-gated.

Contract v20 repairs only authorized replay of a consumed legacy receipt. A
`config_revision` plugin actor remains bound to this exact operator receipt;
both current console and authorized-approver issuance remain guarded. Fresh
legacy NULL provenance remains refused; only an exact replay already bound to
a committed mutation returns its recorded outcome. The v20 receipt is future
live evidence only after v20 `dist` is live. Doctor must report 4/4/4 VERIFIED
from LIVE STATE for v20; merge, suite, review, or a v19 receipt does not close
the gate.

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
- RULE 0 — VERIFY BEFORE ASSERTING: operator rule, issued directly; every
  other rule tonight is a special case. Before asserting, NAME THE ARTIFACT
  THAT WOULD SETTLE IT — the file, diff, row, surface — and READ it; not the
  report about it. If you cannot read it, UNVERIFIED goes in the claim itself;
  a flagged unread thing is a promise to read it before anyone acts. My
  surface shows nothing is not nothing exists — absence of evidence on one
  surface is evidence about the surface. Where two independent surfaces
  exist, corroborate across both — trust the agreement, not either surface.
  Re-verify before restating — a claim true when made goes stale. Escalation
  pressure is the TRIGGER, not the exception — the urge to warn fast is the
  signal to verify first. Evidence: failure cases are GH-124 merge-hold on an
  unopened diff; spec inferred from ack pattern; two-binding-fields
  assertion; fresh-candidate-thread assertion versus the hardcoded exemption;
  case-sensitive non-delta count; zero-pending-inputs claim; queue-invisibility
  defect filed against the platform capability doc. Corroboration cases are
  SDK-vs-CLI SHA-256 parity; three-thread density; the 40.7 percent span
  measurement.
- RULE 1 — BEFORE SENDING TO A LANE, READ ITS QUEUE. If any messages are
  queued: do not append; clear them; deliver ONE bundled superseding message
  as a STEER. Contradiction resolution and moot-item dropping are the
  sender's work. Clarity of authority: prefer one sender per lane; this is a
  practice, not a Rule-1 obligation.
- RULE 2 — steer when current work would become wrong or wasted; queue only
  later-step shaping with an explicit precondition; a correction is never
  queued; more than one outstanding means bundle and steer; never queue
  authorization. Worker-brief template: WHEN YOU DRAIN SEVERAL MESSAGES AT
  ONCE, ENUMERATE THEM AND SAY WHICH YOU ARE ACTING ON.

## Review and release obligations

- Tier-A work receives a structurally independent local cold review of the
  exact candidate head before merge. Tier-B work merges on local verification
  and CI, then receives cold review post-merge in parallel; a confirmed serious
  defect follows the existing revert path, otherwise findings become follow-up
  work. Tier-C documentation, mechanical edits and additive tests use local
  verification and CI only.
- Every reviewer lane dispatch carries an explicit SUPPORTED profile naming
  provider or harness, model, reasoning level, service tier, permission mode,
  and visibility. The known-good Tier-A default is
  `codex/gpt-5.6-sol/high`; a bare model name that resolves to an unsupported
  tier is a spawn defect, not a review result. If the requested profile cannot
  execute, stop as BLOCKED and do not claim a review verdict.
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
- The `pull_request_target` lifecycle workflow uses `contents: read`,
  `issues: write`, and `pull-requests: write` for its merge trigger and its
  specific merged-PR backfill trigger, with code checked out from
  `refs/heads/main`; it never executes the PR head or merge ref. Its
  deterministic marker/concurrency path is projection evidence, not canonical
  governance.
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
