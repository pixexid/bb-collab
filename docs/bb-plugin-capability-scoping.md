# BB plugin capability scoping

Scope: BB `0.37.0` plugin SDK/app declarations and packaged authoring guide,
plus the installed Pi extension, TUI, RPC, and security documentation. This
describes capability, not authorization: BB plugins are full-trust server code.

## A. Thread list, badges, pulses, colors, avatars, and side panels

### Thread list

- `app.slots.experimental_threadList` replaces the scrolling thread area
  wholesale. It is exclusive; the built-in list remains the default and the
  user selects the provider per client in Settings → Appearance → Sidebar.
  New-thread, search, plugin-navigation rows, and the footer remain
  host-rendered.
- A replacement list reads live rows with
  `experimental_useSidebarThreads()`. Each row exposes thread/project identity,
  title, parent/origin/plugin, provider, pending-interaction state, activity
  counts, unread/pinned/archived state, environment/branch, host, timestamps,
  and BB's resolved `indicator` plus accessible `indicatorLabel`.
- The SDK supplies no status component. The plugin draws its own glyph and row
  layout, so arbitrary badges, avatars, colors, and additional per-row UI are
  possible in the replacement component. Use the host's theme-token classes or
  plugin CSS rather than assuming fixed palette values. Pull-request state is an
  opt-in per-row lookup and includes a rolled-up `attention` value suitable for
  coloring a badge.
- The host row DTO has no plugin-defined avatar or custom-state fields. Key
  custom state by `threadId` in plugin storage; do not treat the host's
  `indicator`, unread flag, or activity counts as plugin-owned state.
- There is no ordinary stable API for decorating rows in the built-in list.
  The experimental trusted content-script setter can paint one plugin-owned
  status on an explicit thread row: `{ icon, label, tone }`, where tone is
  `default`, `running`, `success`, or `error`. `running` gets the host shimmer;
  the host scopes the status to that plugin generation and clears it on
  deactivation. This is the supported host-painted pulse/status affordance, not
  a general avatar or arbitrary CSS hook.
- A plugin can also use `experimental_threadHeaderAction` for a live per-thread
  control/status/count. It mounts once per visible split-pane thread and is
  constrained to the short header action row; larger UI belongs in a popover.

### Side panels

- `threadPanelAction` adds an entry to the thread side-panel new-tab launcher.
  Its component receives `{ threadId, params }`; JSON params persist with the
  panel tab across reloads, and distinct params can create sibling tabs.
- `navPanel` owns a plugin route and gets its own sidebar entry. A plugin can
  render arbitrary React UI there. The host-shipped `ThreadChat` component is
  available for full, compact, or timeline presentation; other UI components
  are plugin-owned.
- Per-thread state that is only React state is per component mount. Durable
  plugin state belongs in plugin storage; persisted panel params are the one
  explicit side-panel state surface.

## B. Storage, secrets, and operator prompts

- `bb.storage.kv` provides namespaced JSON key/value rows in `bb.db`, with a
  256 KiB value limit. `bb.storage.database()` provides the plugin's separate
  SQLite database at `<dataDir>/plugins/<id>/data.db` (WAL, five-second busy
  timeout); `bb.storage.migrate()` applies append-only, transactional numbered
  statements. Reload/dispose closes database handles.
- Declarative settings (`bb.settings.define`) render in the host UI and are
  editable through the plugin configuration CLI. A string setting marked
  `secret: true` is stored in a `0600` file under the plugin secrets directory,
  never in the database or frontend. `useSettings()` exposes effective
  non-secret values only; read secrets server-side. The plugin may still read
  them, so this is storage isolation, not a sandbox.
- `bb.ui.requestInput()` is the plugin-owned blocking form surface. The backend
  supplies a `threadId`, `rendererId`, title, JSON payload, and optional timeout
  (default ten minutes, maximum one hour). The matching frontend
  `pendingInteraction` slot temporarily replaces the composer; submit/cancel
  returns a JSON result to the waiting backend call. Payloads/results are capped
  at 64 KiB and are not persisted; keep sensitive values in component state.
- There is no separate SDK `confirm()` primitive. Use `requestInput()` for a
  plugin-owned yes/no or structured prompt, and use host-bound actions for host
  confirmations. For example, sidebar `requestDelete()` opens BB's recursive
  delete confirmation and deliberately has no silent delete path.

## C. Events and wake surfaces

- `bb.events.on()` exposes exactly six observe-only lifecycle events:
  `thread.created`, `thread.active`, `thread.idle`, `thread.failed`,
  `thread.archived`, and `thread.deleted`. Handlers run fire-and-forget after
  the transition, cannot veto or delay a turn, and are broadcast to loaded
  plugins regardless of sidebar visibility. For content, read the timeline
  after `active`/`idle`; `created` can precede the first user message.
- `bb.sdk.subscribe()` is the typed entity-change stream (`thread`, project,
  environment, host, and system changes). `bb.sdk.threads.events.list/wait()`
  and `bb.sdk.threads.wait()` provide pull/wait access to thread events and
  state. SDK thread operations also let a plugin spawn, send, queue, steer,
  stop, or update threads; spawned threads are attributed to the plugin by
  default.
- `bb.realtime.publish()` sends an ephemeral `plugin-signal` WebSocket message
  to connected clients; `useRealtime()` receives it. There are no persisted
  signals, replay, or per-channel subscriptions. Use
  `useRealtimeConnectionState()` and refetch durable state after reconnect.
- `bb.background.service()` is a long-lived, abortable service with capped
  crash backoff. `bb.background.schedule()` is a durable five-field cron row
  with CAS claiming, but it fires only while the plugin is loaded. These are
  the plugin's background wake mechanisms; realtime alone is not a durable
  wake guarantee.

## Evidence read

- Installed Pi docs: `docs/extensions.md`, `docs/sdk.md`, `docs/rpc.md`,
  `docs/security.md`, and `docs/tui.md` under
  `/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/@earendil-works/pi-coding-agent/`.
  Pi extensions have terminal TUI/status/widget/confirm APIs; those are
  separate from BB's web plugin sidebar contract.
- `bb-app@0.37.0` npm package: packaged `bb-plugin-authoring/SKILL.md`,
  generated `types/bb-plugin-sdk.d.ts`, and
  `types/bb-plugin-sdk-app.d.ts` from `bb plugin types`.
