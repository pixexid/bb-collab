# Issue #63 operator console

The `Lanes` `navPanel` is the universal approval surface, including connected
phone web clients. Its `Awaiting operator` section reads only live BB plugin
interactions whose renderer is `operator-receipt` and whose payload is the
canonical exact receipt binding.

Approval re-fetches that host interaction, rejects binding drift, resolved or
foreign interactions, missing or incorrect `operatorPassphrase`, and worker
self-approval, then uses the existing receipt persistence seam before resolving
the same worker interaction. The passphrase is a `secret: true` setting and is
never returned to the app or stored in plugin SQLite. The receipt's existing
caller-thread provenance plus the exact host interaction id in the approval
evidence identify the connected session; no second authority store is added.

Desktop `requestInput` remains registered as the crown-jewel fallback path.
This issue does not install or reload the live plugin, add director attestation,
provisioning, or GitHub/PR operations.

## Unset-passphrase onboarding, and where the settings affordance lives

`useSettings()` excludes secret settings by contract, so the console cannot tell
"unset" from "set but not yet typed" from the frontend. The `operatorPassphraseState`
rpc answers that one question and nothing else: its output schema is
`{ configured: boolean | null }` strict, so passphrase material has no field to
ride out on.

The state is deliberately tri-state on the server and four-state in the panel,
because "the passphrase is not set" and "we could not find out" are different
facts and only the first is the operator's to fix. `readOperatorPassphrase` is
the one place the secret is read and returns exactly one of them; a settings
read that throws is logged and answered `null`, never coerced to `false`.

| `configured` | `Awaiting operator` shows | Approval controls |
| --- | --- | --- |
| *(not answered yet)* | nothing | disabled |
| `true` | nothing | armed |
| `false` | **Set your approval passphrase first**, naming the settings affordance below | disabled |
| `null` | **Can't check the approval passphrase** — the check failed, nothing needs setting up — plus **Try again** | disabled |

A rejected rpc call is the same fact as a `null` answer and renders identically.
Every non-`true` state is fail-closed: the input, `Approve` and `Reject` are all
disabled, and the decision path refuses independently on the server, so the
disabled controls are a courtesy and never the authority.

The affordance that opens the field is a `sidebarFooterAction`, not an in-panel
link. That is a capability boundary, not a preference:

| Surface | What it gives, and why it is not a settings link |
| --- | --- |
| `navPanel` component props | `PluginNavPanelProps` is `{ subPath }`. No `openSettings`, no settings route. |
| `navPanel.headerContent` | Same props; renders in the panel title bar, which is only visible once the panel is already open. |
| `useBbNavigate()` | `toThread`, `toProject`, `toPluginPanel`, `toCompose`, `openThreadPanel`. No settings destination. |
| `sidebarFooterAction` `run` | **The only sanctioned path.** `PluginSidebarFooterActionContext.openSettings()` navigates to this plugin's Tools detail page, where the declared `operatorPassphrase` setting renders. |

So the plugin registers footer action `bb-collab-settings`, and the in-panel copy
names it exactly — "Open **bb-collab settings** in the sidebar footer, then fill in
**Operator approval passphrase**" — rather than rendering a link it cannot wire.
Changing that title without changing the copy breaks a followable instruction;
`tests/operator-console.test.tsx` asserts both against the same constant.

## Sidebar waiting state: what is supported, and what is not

**The Lanes nav row itself cannot be badged.** `PluginNavPanelRegistration` is
`{ id, title, icon, path, component, headerContent? }` — no badge, count, or
attention field — and `PluginContentScriptContext` exposes no nav-region handle.
`docs/sidebar-plugin-nav-collapse.md` records the same boundary for the same
region, and `tests/sidebar-nav-capability.test.ts` is its standing tripwire. The
refused workarounds are unchanged and listed there: host `data-testid`
selectors, `nth-child` position, and writing `bb.sidebar.*` client storage.

What *is* supported is the sanctioned thread-row status surface the lane pulse
already uses, `PluginContentScriptContext.experimental_setThreadRowStatus`. The
existing `lane-thread-status` content script now folds pending receipt counts
into its existing 5s poll, so a waiting approval is visible in the sidebar
without opening the panel — on the worker thread's row, in both the built-in
thread list and this plugin's replacement list.

Its limits, stated plainly:

- **The count is not a visible numeral.** `PluginComposerThreadRowStatus` is
  `{ icon, label, tone }`: one glyph plus an accessible name. The count reaches
  the label ("2 approvals awaiting operator on this thread (3 in all lanes)"),
  never the pixels. No plugin surface can draw a numeric badge here.
- **It is the worker thread's row, not the Lanes nav row.** Requirement 2 as
  written is therefore *not met*; this is the nearest supported behaviour.
- **A row carries one status**, so an awaiting-operator state overwrites that
  thread's lane pulse. An approval nobody can see is what stalls the lane.

The counts arrive over `GET /operator-receipt-waits`, which returns
`{ total, threads }` and deliberately carries no project, candidate head,
request digest, or idempotency key — a glyph has no use for receipt binding.
A failed interaction read answers 503, never `{ total: 0, threads: {} }`: a
proven zero clears the row, so an outage must stay distinguishable from one and
leave the last known status in place.

**Deletion condition.** Delete this section and the tripwire in
`tests/sidebar-nav-capability.test.ts` when BB ships a nav-row attention or
badge field on `PluginNavPanelRegistration` (or an equivalent app-SDK hook).
The waiting state moves to the nav row and the thread-row fallback goes away.

## Deferred operator-gated queue items

Issue #61 landed the queue-lane data this console was waiting for, so the
deferred state is now consumed rather than guessed. `LaneView` in
`src/awareness.ts` carries `queueState: "ready" | "running" | "deferred"`,
`queueBlocked`, `nextStartable`, `deferredReason` (`"awaiting_operator"` or
`null`), `deferredAtMs` and `deferredAgeMs`, alongside the pre-existing
`waitingOn` and `ageMs`. All of it arrives on the `lanes` rpc the panel already
polls every 5s — there is no second endpoint, fetch or store for it, and none
is needed.

`laneQueueLabel` in `app.tsx` is the whole rendering, and it says one of:

| Lane state | Row status text |
| --- | --- |
| `queueState: "deferred"` | **Deferred · awaiting operator · 5m** |
| deferred, `deferredAgeMs: null` | **Deferred · awaiting operator** |
| deferred, `deferredReason: null` | **Deferred · reason unavailable · 5m** |
| `nextStartable` | next startable |
| otherwise | `waitingOn`, else `worker` |

Two deliberate choices there:

- **The age is the deferral's, never the lane's.** `deferredAgeMs` and `ageMs`
  are different clocks — a lane can be hours old and deferred for five minutes —
  so an absent `deferredAgeMs` prints no duration rather than the lane's.
- **Deferred wins on either field.** #61 sets `queueState` and `deferredReason`
  together; a bundle that outlives its server build and sees only one still must
  not report a deferred lane as merely waiting.

**This is informational state, not a gate.** #61 leaves `queueBlocked` false for
a deferred lane precisely so it does not stall the queue, and the console
matches that: the lane renders in the same list in the same order as any other,
and `Awaiting operator`'s controls are armed by the passphrase state alone —
never by whether some lane is deferred. `tests/operator-console.test.tsx` asserts
both the labelling and that non-blocking presentation; the queue semantics
themselves are #61's and are covered in `tests/awareness.test.ts`.
