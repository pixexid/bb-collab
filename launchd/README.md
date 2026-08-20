# Durable wait-validator LaunchAgent (issue #93)

This directory ships the host-supervision artifact for the registered-waits
validator. It is **not installed by any code lane**: loading it is an
operator act, taken only after the review/CI/release gates for the change
that introduced it have passed.

## Succession-safe stall guard (GH-112 Option C)

`scripts/stall-guard.mjs` supervises one model-free plugin cycle:

```
bb plugin run bb-collab stall-guard --cycle
```

The plugin resolves the canonical role holder on every cycle, polls the
host's pull-request/check state, and persists artifact snapshots in plugin
KV. The role idle ledger remains the owner of the ten-minute floor, two-steer
cap, and escalation behavior. A holder succession therefore retargets the
next cycle without stopping or restarting the guard.

`com.bbcollab.stall-guard.plist` is a template. It retains
`@@REPO_ROOT@@`, `@@STATE_DIR@@`, `@@HOME@@`, `@@NODE_BIN@@`, and `@@BB_BIN@@`
until the install command substitutes them. The repository root must be
repointed and the LaunchAgent reloaded whenever that checkout moves; otherwise
a stale checkout runs stale supervisor code (#125).

The substitutions are required because launchd gives a job a minimal
environment; it does not inherit an interactive shell's PATH or tilde
expansion. Derive them from the install shell (`pwd -P`, `printf '%s' "$HOME"`,
`command -v node`, and `command -v bb`) and write them into a temporary copy of
the template. `BB_BIN` is deliberately an absolute path, and `~/.local/bin` is
explicitly included in the job PATH so the installed job can resolve the same
user-local tooling without relying on login-shell setup. `NODE_BIN` is absolute
for the same reason; there are no bare command names or relative executable
paths left in this plist. The state-directory substitution is also exported to
the script, so its liveness marker and launchd logs use the same directory.

The old `bb-collab-stall-guard.sh` is superseded. During the manual install,
the operator must kill its live processes and must not restart the copy under
the old thread-storage directory. The merge does not kill any process.

The stall guard has exactly two self-watch mechanisms: launchd `KeepAlive`,
and the plugin's `stall-guard-liveness` staleness alert, which alerts once per
episode. There is no watcher-of-watchers.

## What is supervised

`scripts/wait-validator.mjs` is a pure-code loop — no model, no tokens, no
discipline required. Each cycle it runs one in-plugin validation cycle
through the sanctioned CLI seam:

```
bb plugin run bb-collab wait-validator --cycle
```

and then refreshes the liveness marker at
`$BB_COLLAB_VALIDATOR_STATE_DIR/wait-validator.liveness`
(default `~/.bb/bb-collab/wait-validator.liveness`) **regardless of cycle
success**, so a fresh marker proves the supervised process lives even while
bb itself is down. All validation state (registered waits, fired-wake
dedupe, escalation ledger) lives in the plugin KV store, so a validator
restart — including `kill -9` — neither re-fires nor forgets a wake.

`KeepAlive=true` is the first self-watch mechanism: launchd restarts the
process on death. The second mechanism is the staleness check implemented by
the plugin's `wait-validator-liveness` schedule (and available standalone as
`scripts/wait-validator-liveness-check.mjs` for hosts that prefer cron or
the notify plugin's schedule); it alerts the operator exactly once per
staleness episode and never repeats. There is no third mechanism and no
watcher-of-watchers.

## Operator install (manual, after gates pass)

1. Substitute the placeholders in the plist:
   - `@@REPO_ROOT@@` → this checkout's absolute path.
   - `@@STATE_DIR@@` → the marker/log directory (default `~/.bb/bb-collab`;
     create it). Set `BB_COLLAB_VALIDATOR_STATE_DIR` in
     `EnvironmentVariables` if you use a non-default directory — the plugin
     reads the same variable.
2. Install and load:
   ```
   mkdir -p ~/.bb/bb-collab
   plutil -lint launchd/com.bbcollab.wait-validator.plist
   launchctl bootstrap "gui/$(id -u)" launchd/com.bbcollab.wait-validator.plist
   ```
3. Verify the drills from the spec:
   - `kill -9` the validator → launchd restarts it; no wait is lost, no wake
     double-fires (KV dedupe).
   - Restart bb entirely → registered waits survive, validation resumes,
     nothing re-fires.
   - `tail ~/.bb/bb-collab/wait-validator.log` shows one cycle result per
     interval; the marker file's content is a fresh timestamp.
4. The log at `~/.bb/bb-collab/wait-validator.log` grows one JSON cycle
   line per interval (~5.7k lines/day). Rotate or truncate it like any
   launchd `StandardOutPath` artifact; the loop is stateless across log
   loss.
5. Optional host cron (belt alongside the plugin schedule, never instead of
   launchd):
   ```
   */5 * * * * node @@REPO_ROOT@@/scripts/wait-validator-liveness-check.mjs
   ```

## Stall-guard operator install (manual, after gates pass)

1. Derive the five substitutions from the live checkout and host, then render
   a temporary plist; this edits neither the repository template nor the live
   installed job:

   ```sh
   repo_root=$(cd /path/to/bb-collab && pwd -P)
   state_dir="$HOME/.bb/bb-collab"
   node_bin=$(command -v node)
   bb_bin=$(command -v bb)
   sed -e "s|@@REPO_ROOT@@|$repo_root|g" \
       -e "s|@@STATE_DIR@@|$state_dir|g" \
       -e "s|@@HOME@@|$HOME|g" \
       -e "s|@@NODE_BIN@@|$node_bin|g" \
       -e "s|@@BB_BIN@@|$bb_bin|g" \
       "$repo_root/launchd/com.bbcollab.stall-guard.plist" \
       > /tmp/com.bbcollab.stall-guard.plist
   mkdir -p "$state_dir"
   ```

   Check that each derived value is non-empty and absolute before loading.
2. Kill the superseded shell-guard PIDs, then verify that no old shell guard
   is running. Do not perform either action as part of the merge.
3. Load the new LaunchAgent:

   ```
   mkdir -p ~/.bb/bb-collab
   plutil -lint /tmp/com.bbcollab.stall-guard.plist
   launchctl load /tmp/com.bbcollab.stall-guard.plist
   ```

4. If the live checkout moves, substitute the new path and reload the plist.
   The marker is `@@STATE_DIR@@/stall-guard.liveness`; its freshness proves
   the host loop is alive even when a plugin cycle fails.

## Uninstall

```
launchctl bootout gui/$(id -u)/com.bbcollab.wait-validator
```

## Deletion condition

This artifact retires when BB natively hosts plugin background work
surviving app restarts/crashes/updates (see the canonical intake rule and
get-bb/bb#1543); at that point the in-plugin cycle already covers
validation and the LaunchAgent is dead weight. The terminal stall-guard
retirement named in issue #93 is a separate, explicit operator decision and
is not performed by installing this agent.
