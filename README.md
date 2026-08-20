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

## Deploy sequence

The orchestrator owns deploys. A lane does not deploy, and an irreversible or
production-changing action gets its own message rather than a line in a status
burst. Immediately after a lane finishes, run its terminal WorkItem transition;
otherwise a completed lane is indistinguishable from a silent one and coverage
goes blind for the wrong reason.

Run this sequence from the deploy checkout:

```sh
git merge --ff-only origin/main
find dist -type f -exec touch {} +
node scripts/check-dist.mjs --deployed
bb plugin reload bb-collab
bb plugin list
bb collab doctor --project <id>
# Wait more than 15 seconds.
node scripts/check-dist.mjs --deployed
# Run the change's live acceptance query against SQLite with ?mode=ro.
```

The fast-forward merge binds the deploy to the current integrated main and
refuses accidental local history. The first `check-dist` proves the deployed
checkout before the host can load it; reload then makes that checked artifact
the running revision. Doctor checks the live project's store conformance before
acceptance, and the final query is the change's own live proof rather than a
green build standing in for it.

Touch `dist` after the merge so the deployed artifacts are newer than the
sources before the pre-load check. The BB host rebuilds `dist/app.js` and
`dist/app.css` during plugin load when a source is newer; without this margin,
the load can write build-location paths into the deployed artifact and the
next deploy fails its check. Equal mtimes currently pass because the gate is
“exceeds”; the real margin avoids that boundary condition.

`reload-exit=0` is only the loader's verdict. `bb plugin list` is required
because a reload once left the old lane-watcher resident with a closed database
handle: the loader exited 0 while the plugin was DEGRADED, `bb collab` had
vanished, and coverage went unrecorded for fifteen minutes. The list reports
nothing on every healthy deploy, which is why it is easy to drop.
If it shows DEGRADED, do not trust a second reload: it can clear the label
while leaving the orphaned service resident; `bb plugin disable bb-collab`
followed by `bb plugin enable bb-collab` unloads the code entirely, then verify
recovery from the store because the log lags.

Wait before the second deployed-artifact check: the rebuild landed about 13
seconds after reload returned, and an immediate check twice gave a confident
false exculpation. The live acceptance query must use `?mode=ro`; `?immutable=1`
ignores the WAL and produced stale coverage in the incident. Right after reload,
`?mode=ro` may fail with “unable to open database file (14)” because clean WAL
shutdown removes sidecars and a read-only connection cannot create `-shm`.
Wait and retry; do not switch to the write-permitting plain path.

## Incident logs

For the durable `bb-collab` emission history, read:

```sh
~/.bb/plugins/bb-collab/logs/plugin.log
```

`bb plugin logs bb-collab` shows only the tail of that file (100 records at
the time of verification). The host-daemon files at
`~/.bb/logs/host-daemon*.log` are a separate operational stream: they do not
contain the plugin's emitted records and are not a valid negative control for
plugin events. Search `plugin.log` when checking whether a plugin event did or
did not occur.

Verification snapshot, 2026-08-20: `plugin.log` contained 3,269 JSON records
from `2026-08-13T21:37:01.166Z` through `2026-08-20T04:20:50.841Z`, including
594 `fleet-watchdog` records. The overlapping 100 records from
`bb plugin logs bb-collab` matched 0/100 daemon records by timestamp, level and
message; none of their messages appeared in the daemon logs.

## Executed profile read-back

For a completed Codex, Claude Code, or Pi thread on the current host, correlate BB's
provider session and completion IDs with the provider-native turn records:

```sh
npm run --silent executed-profile -- --project PROJECT_ID --thread THREAD_ID
```

The command reports only provider-native executed model/reasoning evidence. It
returns `unknown` rather than substituting requested spawn fields when the
native record is absent, conflicting, still running, or from an unsupported
provider. A Claude Code base-family observation such as `claude-opus-5` remains
visible as `observedProfile`, but its compliance result is `unknown` because it
does not establish an exact dispatched SKU or context-window suffix such as
`[1m]`. The reader never normalizes or guesses that suffix.

Pi session logs are scoped to the exact environment-derived project directory.
Its assistant entry id must exactly match BB's completion checkpoint id; the
entry supplies provider/model and its ancestor state supplies the reasoning
level. Missing directories, unreadable logs, absent or ambiguous matches, and
checkpoints that appear only as parent links stay named unknowns.

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

CLI flag sets:

- `bb collab send-to-operator --project PROJECT_ID --recipient operator|supervisor --severity routine|needs-decision|urgent --message TEXT`
- `bb collab inbox --project PROJECT_ID [--recipient operator|supervisor | --mark-read MESSAGE_ID]`

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
  ([#342](https://github.com/pixexid/bb-collab/pull/342)); lane-slot utilization reads
  forward-only `lane_capacity_intervals`; liveness never extends observed fact coverage, and any
  pre-instrumentation or recording gap remains unknown;
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
