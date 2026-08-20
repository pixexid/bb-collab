# bb-collab

BB-native project governance, work lifecycle, and collaboration runtime.

## Deployed artifact check

The recurring `fleet-watchdog` schedule runs
`npm run --silent check:deployed-dist`'s underlying read-only check every five
minutes while the plugin is loaded. You can also run
`npm run --silent check:deployed-dist` from any checkout. It resolves the
installed `bb-collab` path through bb and refuses an absent or non-path source.
It is silent when tracked `dist/` there matches the deployed commit; otherwise
it exits nonzero and names every divergent artifact against the deployed
commit. The scheduled check reports divergence;
it never rebuilds, repairs, or commits the deployed checkout.

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

CLI consumers branch on `outcome`; `message` is prose and never a branch key.
Use only codes in the ADR 0001 table; a code absent from that table is not to be
invented at a call site.

## Founding status

The implemented runtime and schema versions are the authoritative
[`RUNTIME_CONTRACT_VERSION` and `SCHEMA_VERSION` constants](src/foundation.ts);
do not transcribe them here. The separate instruction contract is
`INSTRUCTION_CONTRACT_VERSION` in `AGENTS.md`.
Director profile selection is likewise intentionally omitted from this summary;
resolve it from canonical live state when needed.

Shipped operational surfaces include:

- the durable [operator inbox](#operator-inbox);
- the read-only doctor and explicit apply/verify path, including installed-plugin
  compatibility, standby declaration, routing-uniformity and provider-collapse
  checks, plus JSON WorkItem registration facts ([#323](https://github.com/pixexid/bb-collab/pull/323),
  [#326](https://github.com/pixexid/bb-collab/pull/326),
  [#327](https://github.com/pixexid/bb-collab/pull/327),
  [#333](https://github.com/pixexid/bb-collab/pull/333), and
  [#336](https://github.com/pixexid/bb-collab/pull/336));
- the `fleet-watchdog` no-seat floor, queue-intake, liveness, and recovery checks;
- exact current role binding lookup with
  `bb collab role-list --project PROJECT_ID`
  ([#330](https://github.com/pixexid/bb-collab/pull/330));
- the weekly GitHub-backed throughput report, invoked with
  `npm run throughput-report -- --repo OWNER/REPO --start START_ISO --end END_ISO --dials-landed-at DIALS_ISO`
  ([#342](https://github.com/pixexid/bb-collab/pull/342));
- the report-only static production reachability check, invoked with
  `node scripts/check-production-reachability.mjs`
  ([#347](https://github.com/pixexid/bb-collab/pull/347)); and
- the `review_pending` WorkItem lifecycle state, which separates completed
  authorship from work awaiting review
  ([#295](https://github.com/pixexid/bb-collab/issues/295)); and
- the non-terminal, zero-writing-capacity `blocked` WorkItem state, entered
  atomically with a machine-evaluable `work_item_succeeded` or
  `github_issue_closed` condition. The watchdog returns a fired blocker to
  `ready`; a GitHub closure triggers reassessment and does not prove that an
  installed host capability now exists
  ([#200](https://github.com/pixexid/bb-collab/issues/200)).

Historical contract and schema decisions belong in the
[ADRs](docs/adr/), especially the [founding contract](docs/adr/0001-founding-contract.md)
and the [director-role split](docs/adr/0002-director-role-split.md), rather than
in a second versioned narrative here.

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
   ExecutionAttempt records, exact requested-profile provenance, isolated
   environments and terminal reports. Executed-profile readback remains a BB
   platform gap tracked by GH-215 and upstream get-bb/bb#1787.
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
