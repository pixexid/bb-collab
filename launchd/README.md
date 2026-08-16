# Durable wait-validator LaunchAgent (issue #93)

This directory ships the host-supervision artifact for the registered-waits
validator. It is **not installed by any code lane**: loading it is an
operator act, taken only after the review/CI/release gates for the change
that introduced it have passed.

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

## Uninstall

```
launchctl bootout gui/$(id -u)/com.bbcollab.wait-validator
```

## Deletion condition

This artifact retires when BB natively hosts plugin background work
surviving app restarts/crashes/updates (see the roadmap and
get-bb/bb#1543); at that point the in-plugin cycle already covers
validation and the LaunchAgent is dead weight. The terminal stall-guard
retirement named in issue #93 is a separate, explicit operator decision and
is not performed by installing this agent.
