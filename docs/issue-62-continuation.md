# Issue 62 continuation mechanism

`lane-watcher` uses the native `bb.sdk.threads.send` steer surface with the
text input marked `visibility: "agent-only"`. The host still owns the normal
thread-row pulse and execution badge, so a continuation creates a real native
thread event without adding a chat-visible message.

Continuation state is one persisted plugin KV record, keyed by project and
execution attempt. The watcher serializes observation work and claims the
next continuation before calling the SDK. A successful send settles the
claim. A send error leaves it claimed because delivery may have happened.
On reload, every claimed record becomes `paused` with its count preserved;
the next idle observation alerts for explicit review and cannot send again.

Modes are derived from the existing assignment kind:

- `write`: `automatic`, bounded to three continuations by default.
- `review` (Tier-A): `approval`, alert-only; it never auto-steers.
- `probe`: `tracking`, observation-only; it never auto-steers or alerts.

Reaching the per-lane limit persists `limit_reached`, pauses further sends,
and emits one operator-facing limit alert. Terminal receipts remain the
existing completion authority; this mechanism does not add a bus, task store,
canonical mutation, or live-install path.
