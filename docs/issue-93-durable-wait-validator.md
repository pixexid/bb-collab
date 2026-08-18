# Issue #93 / #57 mechanism 8: durable registered-wait validator
> Status: The assignment subsystem and lane watcher contract were removed. The assignments table remains as a schema vestige pending consumer enumeration in #192; execution_attempts remains unchanged.


Status: implemented on top of the merged mechanism-8 substrate; host
LaunchAgent **not installed** (operator act after review/CI/release gates).
Frozen acceptance contract: the approved operator addendum for #93, plus
issue #93. The substrate this builds on is described in
[the mechanism-8 bridge](issue-57-mechanism-8.md).

## The cure

The recurring stall class was reliability resting on orchestrator model
discipline: prose in briefs does not bind. The registered-waits cure makes
every "waiting for X" a durable row and makes the substrate refuse the bad
state. There is exactly **one wait store**: the lane watcher's registered-
wait registry (`lane-watcher.registered-waits` plugin KV), written by the
waiter through the sanctioned seams. The watcher fires waits when their
source reaches a terminal/failure state or their deadline expires, dedupes
replays by `waitId`, treats a registered wait as the only legal idle for
workers and the director/dispatcher alike, and never writes canonical
SQLite rows, receipts, or events. This lane (#93) adds the operator-approved
durability and discipline around that one store:

- **Deadline law.** Every wait has a mandatory bounded deadline: the
  8-hour default, or an explicit future integer within the 7-day horizon
  that must carry an `overrideReason`. Explicit `null`, past,
  non-integer, beyond-horizon, and reasonless overrides are refused at
  registration through the waiter CLI seam, fail closed.
- **Source-liveness validation.** A `source_terminal` wait on an unknown,
  archived, already-errored, or unknown-status source is refused — you
  cannot start waiting on something already finished; act on its outcome.
- **Waiter binding and key discipline.** `bb collab wait-register` binds
  the waiter to the calling thread (mismatch refused) and requires an
  `idempotencyKey` per registration: identical replays are idempotent, a
  key rebound to a different wait is a conflict, and a key whose wait
  already fired is consumed — re-waiting on the same source registers a
  new key. This law binds the waiter CLI seam; the app-facing
  `registerWait` RPC is the substrate's own surface and accepts a
  caller-supplied finite deadline (a follow-up may route it through the
  same law).
- **Bounded escalation ladder for fired waits.** A fired wait steers its
  waiter at most twice (grace-spaced, KV-deduped) while the waiter is
  observed idle; an active waiter pauses the ladder — it is alive and the
  wake reaches it, and the ladder resumes if it goes idle; two ignored or
  failed steers escalate to exactly ONE operator alert plus a succession
  trigger. Steers never loop, and a ladder record outlives its fired wait
  exactly as long as the store holds it: retention never re-arms.
- **Host supervision.** `scripts/wait-validator.mjs` is a pure-code loop —
  no model, no tokens — supervised by a launchd LaunchAgent
  (`launchd/com.bbcollab.wait-validator.plist`, KeepAlive=true): it survives
  bb restarts, app crashes, and updates, and the OS restarts it on death.
  Each cycle it runs `bb plugin run bb-collab wait-validator --cycle` (one
  in-plugin cycle: the watcher's wait firing pass plus the escalation pass)
  and refreshes the liveness marker **regardless of cycle success**, so the
  marker proves the supervised process lives even while bb is down. All
  wait state lives in the one plugin KV registry, so a restart — including
  `kill -9` — neither re-fires nor forgets a wake.
- **Self-watch, exactly once.** Mechanism one: launchd KeepAlive. Mechanism
  two: the `wait-validator-liveness` schedule (every 5 minutes while the
  plugin is loaded; standalone `scripts/wait-validator-liveness-check.mjs`
  for cron/notify-schedule hosts) alerts the operator exactly once per
  staleness episode, deduplicated through a shared `wait-validator.alerted`
  flag file that a fresh marker clears. A missing marker is never
  launchd-failure evidence and stays silent. There is no third mechanism
  and no watcher-of-watchers.

## Surfaces

| Surface | Where |
| --- | --- |
| One wait store: registry, firing, legal-idle integration | `src/awareness.ts` (mechanism-8 substrate) |
| Deadline law, source-liveness validation, waiter binding | `registerBoundedWait` in `src/registered-waits.ts` |
| Bounded escalation ladder, liveness rule | `createWaitEscalationCycle` / `liveness*` in `src/registered-waits.ts` |
| Waiter CLI seam (`wait-register`, `wait-list`, `wait-validator --cycle`) | `server.ts` |
| In-plugin validation cadence | `lane-watcher` service loop + escalation cycle each second |
| Host-supervised loop (launchd KeepAlive) | `scripts/wait-validator.mjs` + `launchd/` |
| Self-watch second check | `wait-validator-liveness` schedule; `scripts/wait-validator-liveness-check.mjs` |

## Deadline law of record

| Input | Result |
| --- | --- |
| no `deadlineMs` | default: now + 8 h |
| explicit future integer ≤ 7-day horizon + `overrideReason` | accepted |
| explicit `null` / past / non-integer / beyond horizon / no reason | refused at registration |

## Fail-closed inventory

- Unknown/archived/errored/unknown-status source at registration → refused.
- Unknown source liveness at evaluation → held (never fired on unknown),
  with the deadline still the bound (mechanism-8 substrate).
- Unknown waiter state → no steer, no escalation; retention bounds the record.
- Malformed KV registry/escalation state → the cycle refuses to act and
  logs; nothing is treated as zero.
- A failed steer send counts as a failed steer; two consecutive failures
  are the same escalation condition as two ignored steers.
- The `--cycle` CLI and the escalation pass are read-only on canonical
  state; a canonical-store outage degrades firing to thread-status/deadline
  evidence only.

## Acceptance drills → tests

Each drill is proven in both directions (acts when it must, refuses/silences
when it must not) by `tests/registered-waits.test.ts` and
`tests/wait-validator.test.ts`:

| Spec drill | Test |
| --- | --- |
| kill -9 validator → launchd restarts; no wait lost, no double-fire | "survives a restart without re-firing or forgetting" + "fires, wakes once, and never re-fires across cycles or restart" + KeepAlive plist assertions |
| restart bb entirely → waits survive, validation resumes, nothing re-fires | same restart drill over persisted KV; the host loop refreshes the marker while bb is down ("refreshes the liveness marker even when a cycle cannot run") |
| kill a worker mid-lane → waiters wake within one cycle with reason=source_terminal | "fires within one cycle when the source errors, archives, or reaches a terminal attempt" (each direction: fires on the fact, holds on a live source) |
| register a wait with no deadline → refused at registration | registration drills (null/past/non-integer/horizon/reasonless/unknown source/event) + plugin-level fail-closed test |
| director idles with startable work and no registered wait → steered within one cycle | mechanism-8 wrongful-idle integration: "treats a pending registered wait as a legal idle and steers only without one" + the substrate's own role-idle tests |
| stale liveness marker → exactly one operator alert, no repeat | "alerts the operator exactly once per staleness episode and re-arms" + standalone second-check script drill |

Plus: escalation bounds (never a third steer, one operator alert, failed
sends count), replay/idempotence through the CLI (default-deadline replays
match on the binding, explicit-deadline conflicts refused, fired keys
consumed), the never-lost wake for a momentarily active waiter, retention
that never re-arms the ladder, and zero canonical SQLite writes
(full-database row digests before/after registration and cycles at the
plugin seam).

Known bounded behavior (follow-up, not a defect of this lane): one
`--cycle` that fires a wait whose waiter is also an open lane worker can
send two wake messages — one from the substrate's own auto-steer
(spending one continuation claim) and one from the ladder — because the
two ledgers are independently bounded. Both are deduped per their own
bounds; the wakes are agent-only.

## Deployment (operator-owned; NOT performed by code lanes)

See `launchd/README.md`. The LaunchAgent is installed only after the
review/CI/release gates for the introducing change pass. The in-plugin
cadence keeps registered waits validated before and independent of launchd
deployment, so the mechanism is never dead code.

## Deletion conditions

- The launchd artifact retires when BB natively hosts plugin background
  work that survives app restarts/crashes/updates (upstream
  get-bb/bb#1543-adjacent hosting work); the in-plugin cadence already
  covers validation at that point.
- The terminal stall-guard retirement named in issue #93 is a separate,
  explicit operator decision; this lane does not retire it.
- The registered-wait substrate retires only if BB provides an equivalent
  native durable-wait primitive; until then it is the cure for the stall
  class, not a bridge.
