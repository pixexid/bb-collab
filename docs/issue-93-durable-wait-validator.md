# Issue #93 / #57 mechanism 8: durable registered-wait validator

Status: implemented; host LaunchAgent **not installed** (operator act after
review/CI/release gates). Frozen acceptance contract: the operator addendum
at `docs/issue-93-durable-wait-validator.md` (this file) transcribing the
approved spec, plus issue #93.

## The cure

The recurring stall class was reliability resting on orchestrator model
discipline: prose in briefs does not bind. The registered-waits cure makes
every "waiting for X" a durable row and makes the substrate refuse the bad
state:

- **Waits are registered, not narrated.** A waiter thread registers the wait
  through the sanctioned CLI seam at the exact moment it decides to wait:
  `bb collab wait-register --project P --request JSON`. Registering the wait
  IS how a thread is allowed to go idle. An unregistered wait is not a legal
  idle reason: the existing lane auto-steer and wrongful-idle detector treat
  idle + startable work + no registered wait as an anomaly, for workers, the
  director, and the dispatcher alike (the detector maps the top seat to the
  supervisor thread exactly as before).
- **Every wait has a deadline.** A wait without a deadline is refused at
  registration, fail closed. Defaults per event type; an explicit override
  must carry a reason; every deadline is bounded by a 7-day horizon.
- **Failure propagates as events, never as silence.** A source thread that
  errors, is archived/deleted, or reaches a terminal attempt state (done /
  blocked / failed / terminal receipt) voids all its waits, and every waiter
  is woken within one validation cycle with reason `source_terminal` and the
  discriminating detail. A deadline that passes fires `deadline_exceeded`.
  One worker dying cascades wakes, not stalls.
- **Bounded escalation.** A fired wait steers its waiter once (KV-deduped).
  A second ignored steer (or a second failed send) escalates to exactly ONE
  operator alert plus a succession trigger. Steers never loop.
- **The watcher is model-free and read-only on canonical state.** The
  validator is pure code: no model, no tokens, no discipline. It reads wait
  rows, thread statuses, and lane/queue facts, and acts only through the
  existing sanctioned seams: agent-only `threads.send` steers, `bb.log` /
  realtime doorbell alerts, and KV dedupe. It never writes a canonical
  SQLite table, never creates or consumes a receipt, and never touches the
  resolver. Wait rows live in the plugin KV seam — there is no second
  authority store and no watcher-owned database.

## Surfaces

| Surface | Where |
| --- | --- |
| Pure model: registry, deadline law, evaluation, escalation, liveness rule | `src/registered-waits.ts` |
| Registration/cancel/list/cycle CLI seam | `bb collab wait-register/wait-cancel/wait-list/wait-validator` in `server.ts` |
| One validation cycle (also run by the in-plugin lane-watcher loop each second) | `createWaitValidator().cycle()` |
| Host-supervised loop (launchd KeepAlive) | `scripts/wait-validator.mjs` + `launchd/com.bbcollab.wait-validator.plist` |
| Self-watch, once: liveness schedule (second check) | `wait-validator-liveness` schedule in `server.ts`; standalone `scripts/wait-validator-liveness-check.mjs` |
| Wait-aware idle legality (worker + director/dispatcher) | `createLaneWatcher` option `readRegisteredWaitFor` in `src/awareness.ts` |

## Deadline law (defaults of record)

| Event type | Default | Notes |
| --- | --- | --- |
| `source_terminal` | 8 h | backstop for a source lane that never terminalizes |
| `operator_response` | 4 h | registered operator waits; the 15-min FYI pattern for pending interactions is unchanged |
| `external_event` | 24 h | CI, external APIs |

An explicit `deadlineMs` must be a future integer within 7 days of
registration and requires `overrideReason`. Unknown event types, explicit
`null`, past/non-integer/beyond-horizon values, and reasonless overrides are
refused at registration with a fail-closed exit.

Registration also validates source liveness: a `source_terminal` wait on an
unknown, archived, or already-errored source is refused — you cannot start
waiting on something already finished; act on its outcome instead.

## Durability and restart safety

Wait rows, fired-wake dedupe, and the escalation ledger live in the plugin
KV store (`wait-registry.waits`, `wait-registry.escalation`), bounded at 128
active waits, 256 terminal history records, and 7-day escalation retention.
Every step persists before the next runs, so a validator restart — including
`kill -9` — neither re-fires nor forgets. Firing is a two-step commit: the
escalation record is persisted first, then the registry terminalization; a
crash between them leaves a record that the next cycle recognizes as
already-fired (no double wake) and an active wait that re-fires cleanly
(the record short-circuits re-steering).

The host loop (`scripts/wait-validator.mjs`) is supervised by launchd
`KeepAlive=true`: the OS restarts it on death, so validation survives bb
restarts, app crashes, and updates. Each cycle it invokes
`bb plugin run bb-collab wait-validator --cycle` (one in-plugin cycle: the
wait validation plus the coalesced lane/role watcher poll) and then
refreshes the liveness marker **regardless of cycle success** — while bb is
down the loop stays alive, keeps the marker fresh, and retries; when bb
returns, validation resumes without re-firing anything.

## Self-watch, exactly once

1. launchd `KeepAlive` restarts the validator process on death.
2. The validator refreshes `wait-validator.liveness` every cycle. The
   `wait-validator-liveness` schedule (every 5 minutes while the plugin is
   loaded) and the standalone `scripts/wait-validator-liveness-check.mjs`
   (for cron/notify-schedule hosts) apply the same rule: a stale marker
   means launchd itself failed — operator territory — and produces exactly
   ONE alert per staleness episode, deduplicated through a shared
   `wait-validator.alerted` flag file that a fresh marker clears. A missing
   marker is never launchd-failure evidence and stays silent.

There is no third mechanism and no watcher-of-watchers.

## Fail-closed inventory

- Unknown source at registration → refused.
- Unknown source liveness at evaluation → held (never fired on unknown),
  with the deadline still the bound.
- Unknown waiter state → no steer, no escalation (the deadline/retention
  bound the record).
- Malformed KV registry/escalation state → the cycle refuses to act and
  logs; nothing is treated as zero.
- Unknown event type, missing deadline resolution, reasonless override →
  registration refused.
- A failed steer send counts as a failed steer; two consecutive failures
  are the same escalation condition as two ignored steers.
- The `--cycle` CLI is read-only on canonical state; a canonical-store
  outage degrades firing to thread-status/deadline evidence only.

## Acceptance drills → tests

Each drill below is proven in both directions (acts when it must,
refuses/silences when it must not) by `tests/registered-waits.test.ts` and
`tests/wait-validator.test.ts`:

| Spec drill | Test |
| --- | --- |
| kill -9 validator → launchd restarts; no wait lost, no double-fire | "survives a restart without re-firing or forgetting" + "fires, wakes once, and never re-fires across cycles or restart" + KeepAlive plist assertions |
| restart bb entirely → waits survive, validation resumes, nothing re-fires | same restart drill over persisted KV; host loop refreshes the marker while bb is down ("refreshes the liveness marker even when a cycle cannot run") |
| kill a worker mid-lane → waiters wake within one cycle with reason=source_terminal | "wakes waiters within one cycle when the source terminalizes" + evaluation table (error / archived / terminal attempt) |
| register a wait with no deadline → refused at registration | "refuses a wait with no deadline" + "refuses past, non-integer, and beyond-horizon deadlines and reasonless overrides" + plugin-level fail-closed test |
| director idles with startable work and no registered wait → steered within one cycle | existing wrongful-idle detector tests (awareness) + "steers the same idle worker without one"; with a registered wait the same idle is legal ("does not steer an idle worker with a registered wait") |
| stale liveness marker → exactly one operator alert, no repeat | "alerts the operator exactly once per staleness episode and re-arms" + standalone second-check script drill |

Plus: source terminalization/failure cascades over every wait on a source,
deadline expiry, duplicate/replay/idempotence (CLI + registry), escalation
bounds (never loops, one alert), director/dispatcher coverage via the same
detector, and zero canonical SQLite writes (full-database digests before and
after registration and cycles, at both the pure and plugin seams).

## Deployment (operator-owned; NOT performed by code lanes)

See `launchd/README.md`. The LaunchAgent is installed only after the
review/CI/release gates for the introducing change pass. The plugin's
in-plugin cycle keeps registered waits validated before and independent of
launchd deployment, so the mechanism is never dead code.

## Deletion conditions

- The launchd artifact retires when BB natively hosts plugin background
  work that survives app restarts/crashes/updates (upstream
  get-bb/bb#1543-adjacent hosting work); the in-plugin cycle already
  covers validation at that point.
- The terminal stall-guard retirement named in issue #93 is a separate,
  explicit operator decision; this lane does not retire it.
- The registered-wait substrate retires only if BB provides an equivalent
  native durable-wait primitive; until then it is the cure for the stall
  class, not a bridge.
