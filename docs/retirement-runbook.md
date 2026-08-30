# One-time governor retirement

Run this once from a named retirement operator. It is a drain and evidence
procedure, not a collaboration runtime. If the governor is already disabled,
do not re-enable it to complete a step; use preserved exports/native records
and record the missing observation.

## 1. Freeze and inventory

1. Stop new governor admission in every governed project. Let native BB work
   continue.
2. For every project, create the existing deterministic complete export before
   disabling the core plugin. Retain `manifest.json`, `records.ndjson`,
   `artifact-index.json`, every referenced artifact, the reported checksums,
   and the export-root digest together.
3. From each export, disposition every nonterminal WorkItem; active, prepared,
   or interrupted attempt; registered wait; role binding; and operator message.
   A disposition may preserve an obligation for ordinary BB/manual follow-up.
   It must not infer success from silence or import a row into replacement state.
4. Inventory native BB threads/environments and Git worktrees separately. An
   export cannot prove that a worktree is clean, unique, or disposable. Preserve
   every dirty or unique worktree until its owner explicitly disposes it.

Do not use a pinned population count: repeat the inventory immediately before
shutdown and reconcile the two reads by stable identity.

### Required #721 preservation hold

Issue #721 must be preserved, not resumed or retired implicitly:

- thread: `thr_xij5mqggch`
- environment: `env_nvat2ac7ai`
- branch: `bb/worker-721-canonical-dispatch-without-github-pro-thr_xij5mqggch`
- head: `6f367289d8b02b1b65f63f4f3682dc52d68c7717`
- uncommitted files: `server.ts`, `tests/server.test.ts`
- binary diff SHA-256: `6d24056cf39cad69b02aca48885c3dfb53a594cc661765c61748051cf6a8a206`

Exclude that environment and branch from archive, cleanup, deletion, reset,
checkout, rebase, or automated retirement. Record its binary diff digest in the
retention manifest and require an explicit owner-approved disposition before
changing any of those facts. Recompute the binary diff digest immediately
before any later disposition; a mismatch means this hold no longer describes
the preserved state and must fail closed.

Accepted exception: a post-implementation native audit found environment
`env_nvat2ac7ai` destroyed outside this lane. The manager in
`thr_5dxicfvxrk` accepted an evidence-only disposition: retain the reconstructed
two-file patch, all 11 completed native `fileChange` events, and the exact
binary diff digest above as read-only forensic evidence. This does not mean
#721 succeeded, and it does not authorize recreating or resuming the attempt.
The missing environment identity cannot be restored and no longer blocks the
retirement drain.

## 2. Exercise native parent delivery

On a non-critical project, use ordinary BB child threads and record native
thread/event IDs plus the parent-visible payload for each case:

- child completed;
- child failed;
- child interrupted;
- parent has a pending interaction when the child finishes;
- parent is active when the child finishes; and
- parent is idle when the child finishes.

Require the native outcome and terminal output to reach the correct parent, and
require pending-interaction delivery to remain deferred until BB can deliver it.
This is an observation gate, not permission to add a relay, watcher, title
protocol, nudge, or startup reconciler. A failure is a BB host defect: preserve
the reproduction and stop the cutover.

## 3. Snapshot and identify the legacy runtime

1. Resolve the exact loaded core runtime commit from BB's resident plugin
   identity. Do not substitute the source checkout's current `HEAD`.
2. Create a SQLite online backup of the host-resolved core plugin database.
   Resolve the database from BB plugin metadata; do not glob or guess a path.
3. Hash the database backup and every complete-export file with SHA-256. Write a
   retention manifest containing the loaded runtime commit, source commit,
   project IDs, export-root digests, file hashes, and #721 hold above.
4. Verify the manifest from a separate read-only location, then make that
   location read-only.
5. Create one lightweight Git tag named `legacy-governor-2026-08-29` at the
   exact loaded runtime commit. The writer lane does not create or push it; the
   retirement operator does so only after the snapshot verifies.

The export and database backup are retained evidence. They are never loaded as
an authority store or migrated into a replacement schema.

## 4. Shut down and prove absence

After a final zero-write inventory and all dispositions:

1. Disable and remove the root `bb-collab` plugin without installing a
   replacement.
2. Disable and remove `companion-watcher` and `exec-tracking`.
3. Disable and remove `lanes`; it calls the retired `v1-lanes` core RPC.
4. Disable and remove `operator-inbox`; its reads, mutations, replies, and
   `send_to_operator` tool depend on the retired core store. The exported
   messages remain in read-only retention. No independent inbox is created by
   this reset.
5. Remove the `com.bbcollab.stall-guard` and
   `com.bbcollab.wait-validator` launchd jobs and their installed plist copies.
6. Remove governor-targeted external schedules or automations. Do not replace
   them with an idle watcher.
7. Confirm the live plugin list has no bb-collab services or schedules, no
   companion semantic watcher, no governor CLI/tool, and no Lanes or Operator
   Inbox RPC surface. Confirm native BB child delivery still works.

The independent Threads List plugin may remain. It uses BB-native thread and
project APIs plus its own display-state storage; it has no governor RPC call.

## 5. Issue disposition

Only after the live instances above are drained, apply one common retirement
disposition to governor-specific issues: WorkItems, roles, receipts,
assignments, projections, waits, review/release authority, bootstrap, and
controller work are superseded by zero runtime. Keep reproducible BB host
defects upstream and keep independently useful UI or one-time worktree hygiene
as separate work. Do not close issues from the writer lane.
