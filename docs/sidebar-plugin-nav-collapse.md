# Sidebar plugin-nav collapse: BLOCKED on host support

Status: **BLOCKED — no sanctioned plugin surface.** Round 3 ships no
implementation.

Scope of the request: default the host sidebar's plugin-navigation section to
two visible rows, reveal the rest behind a `Show more`-style affordance in the
same interaction language as the project list, and default collapsed on
narrow/mobile viewports.

Evidence base: BB `0.37.0` / plugin SDK `0.4.1`, `types/*.d.ts` verified
current with `bb plugin types --check` (both files reported `unchanged`);
packaged `bb-plugin-authoring/SKILL.md`; the running app's live DOM at
`http://127.0.0.1:38886/`; repository head and `origin/main` both freshly
resolved to `01472ec164721e0225be86b96b37e633e0950120`.

## The host already owns this feature

The plugin-navigation region is not an unstructured list. The host renders it
with its own ordering, per-row hide, and overflow disclosure:

- Rows are keyed `` `${pluginId}/${id}` `` and partitioned into `visible` /
  `hidden` by the host.
- Ordering is user-owned and drag-reorderable, persisted client-side under
  `bb.sidebar.pluginPanelOrder`.
- Each row carries a `Hide from sidebar` / `Show in sidebar` context-menu
  item; hidden keys persist under `bb.sidebar.hiddenPluginPanels`.
- Hidden rows already collapse behind a native `More (N)` disclosure button
  with `aria-expanded`.

Live state at the time of inspection: nine rows (Extensions, Lanes, Agent
Proxy, Automations, GitHub, Docs, Usage, Taskboard, Tasks),
`bb.sidebar.pluginPanelOrder` populated, `bb.sidebar.hiddenPluginPanels`
unset — so the `More (N)` toggle is not rendered, and every row shows.

So the requested affordance mostly exists. What is missing is a *policy*: a
default visible cap (rather than per-row manual hiding) and a
narrow-viewport default. Both are host-owned.

## The surfaces inspected, and what each does not give us

| Surface | Result |
| --- | --- |
| `app.slots.*` (`navPanel`, `experimental_threadList`, `sidebarFooterAction`, …) | `navPanel` registers `{ id, title, icon, path, component, headerContent? }` only. No ordering, grouping, visibility, or collapse field. No slot owns the nav region. |
| `experimental_threadList` | Explicitly excludes it: "the search field, the plugin nav rows, and the footer stay host-rendered in every sidebar" (`bb-plugin-sdk-app.d.ts:738`). |
| `app.contentScripts.register` | Trusted same-origin page code, but its context is only `{ pluginId, generation, signal, experimental_setThreadRowStatus? }`. The authoring guide states the context "deliberately has no route/project/thread snapshot yet" and directs authors to "use stable SDK hooks inside React slots rather than polling or installing global navigation observers". The one thread-row hook it does expose targets thread rows, not nav rows. |
| App hooks (`useBbNavigate`, `useBbContext`, `experimental_useSidebarThreads`, …) | Thread/route state only. No nav-region state, no visibility setter. |
| Server SDK (`bb.sdk.system.updateGeneralSettings`, `AppSettings`) | Ten unrelated boolean/string fields. No sidebar nav field; `pluginPanelOrder` / `hiddenPluginPanels` appear nowhere in either declaration file. |
| Live DOM | Region is `<div data-testid="plugin-nav-sidebar-items">` — a test id, no role, no landmark, no `aria-label`. Rows are `<button>` elements with only `class`, `type`, `role`, `tabindex`, `aria-disabled`, `aria-roledescription`, `aria-describedby`; no `href`, no plugin id, no row key. |

## Why the available hacks are refused

- **`data-testid` selectors.** `plugin-nav-sidebar-items` and
  `plugin-nav-sidebar-overflow-toggle` are host test hooks. They appear in no
  SDK declaration, no capability doc, and no authoring guide. Contrast
  `data-sidebar-thread-shortcut-target` / `data-sidebar-thread-id`, which the
  authoring guide *does* publish as a DOM contract plugins must honor — the
  absence of the nav-region equivalent is the whole point.
- **Row identification.** With no per-row identity attribute, singling out
  "the first two" means visible-text matching, generated class matching, or
  `nth-child` position. All three are the fragile matching the brief forbids,
  and position logic in particular breaks the moment the user drag-reorders —
  a gesture the host already supports.
- **Writing `bb.sidebar.hiddenPluginPanels` from a content script.** This is
  the tempting one, and it is the worst: the key was recovered from a
  minified host bundle, it is undocumented host internal state, it is *user*
  preference state (a plugin silently rewriting it hides rows the user chose
  to show), and the host normalizes and writes back the same atom on mount.
  It also stands up a second authority over state the host owns, which
  `AGENTS.md` forbids on principle.
- **Theme CSS.** A contributed stylesheet could `display: none` rows past the
  second, but only via the same testid plus `nth-child` position, with no
  toggle to bind and no reachable expanded state. Same fragility, plus a
  no-escape-hatch accessibility regression.
- **A shadow nav list inside the replaced thread list.** Duplicates nav
  authority, cannot remove the host rows it duplicates, and doubles the
  keyboard/focus surface. Refused.

## Narrow exception: the inbox unread indicator

One use, and one only, is exempted from the refusals above. The operator ruled
that the Inbox nav row must carry unread state before the panel is opened;
`PluginNavPanelRegistration` still has no badge, count, or attention field, and
the gap is filed upstream as get-bb/bb#1852.
`plugins/bb-plugin-operator-inbox/src/inbox-nav-indicator.ts`
therefore matches the host `data-testid` region and the row's visible title, and
resolves the host-rendered `EnvelopeSimple` branding glyph and accents that
glyph when unread messages exist. BB compact chrome normally renders the
plugin-relative SVG as a `[data-plugin-icon-asset]` CSS-mask element; the
indicator targets that element first and retains an SVG fallback for hosts or
fixtures that render the icon as SVG.

**SCOPE: the inbox unread indicator only. The refusal remains doctrine
everywhere else.** Ordering, visibility, collapse, and every other row stay
blocked on host support; nothing above is relaxed.

The exception exists because of one property, and it is the mandatory
condition attached to it: **a coupling that announces its own death is the
difference between this exception and the agent-proxy version the doctrine
refuses.** `paintInboxNavUnread` returns `{ matched: false, reason }` when the
region selector or the row title stops matching. The sidebar poll turns that
into a visible `Inbox unread indicator broken` alert in the thread list — the
one plugin surface that is on screen without opening a panel — and a recorded
`console.error` carrying the reason. Zero-match is never silently nothing.

The switch covers the indicator's deaths, including stale state left behind by
host redraws:

- **Zero-match and stale cleanup.** The region test id is renamed, or the row
  is relabelled, and nothing matches. `paintInboxNavUnread` reports it and
  restores every previously painted row's glyph class/style and host
  `aria-label`/`title` before returning. Detached rows are swept from the
  cleanup-capable painted-row map on each paint, and the panel unmount cleanup
  paints zero as well.
- **Valid but wrong.** Something plausible is still drawn and the operator reads
  it as truth. Missing or ambiguous asset/SVG glyph targets fail closed. Two
  shapes of it are detectable, and both report broken: a *second* row also
  titled `Inbox`, where the accent would land on a row that is not ours; and
  the two rows of this plugin drawing the *same* glyph though they declare
  different icons, which is the precedence collapse and the
  unknown-name-falls-back-to-default case at once. `inspectInboxNavGlyph` reads
  drawn geometry rather than class names — a minified host class says nothing
  about which glyph it is — and compares `Inbox` against the `Lanes` control,
  because a control row is the only thing that tells a collapse apart from a
  fallback. "Geometry" is everything that moves pixels, `transform` and the
  root `viewBox` included, not just `d`: the same path data rotated is a
  different glyph, and a fingerprint blind to that would raise a false alarm
  on a legitimate re-theme. This switch is the retirement signal for
  get-bb/bb#1852, and a signal that fires on noise gets muted.

Unread state is non-color-only: the Inbox control receives the exact unread
count in its accessible label and title. Only the resolved glyph receives the
live theme `text-primary` token; the nav label is not tinted and no dot, span,
or layout gutter is added. At zero, or after drift/unmount cleanup, the
indicator restores the host-owned glyph class/style and aria/title attributes.

**What cannot be detected from inside the plugin, stated plainly:** whether the
glyph drawn beside `Inbox` is the one `Inbox` *declared*. The host owns the icon
registry, exposes no "which glyph did I get" reading, and renders an unknown
name as a default with no error. Comparing against a hardcoded expected path
would only trade this blind spot for a coupling that breaks — loudly and
falsely — the next time the host redraws its icon set. So the check answers the
narrower question it can answer honestly: *did two rows that declare different
icons end up identical.* A single row drawing a wrong-but-unique glyph is not
caught, and `inspectInboxNavGlyph` returns `null` rather than a verdict whenever
the control row or the geometry is unreadable.

`plugins/bb-plugin-operator-inbox/tests/inbox-nav-indicator.test.tsx` fires the
switch on every detectable mode: renamed test id, relabelled row, duplicate
row, collapsed glyph, missing/ambiguous glyph, asset-mask paint/update/clear,
region/title drift cleanup, detached-row cleanup, and SVG fallback.

**RETIREMENT: when get-bb/bb#1852 is resolved upstream, replace this with the
real affordance and re-close the exception.** Delete the Operator Inbox plugin's
`src/inbox-nav-indicator.ts`, its test, the poll in its app, and this section.

## Approved Operator Inbox branding

Operator Inbox deliberately declares the plugin-relative
`./assets/envelope-simple-duotone.svg` as `bb.branding.icon` and as its Inbox
panel icon. This is the approved single-Inbox exception to the general
host-branding refusal: the asset gives compact chrome the Phosphor
`EnvelopeSimple` shape without trying to mount React in host-owned branding.
Panel actions continue to use the React Phosphor components directly.

The branding asset is static; it does not carry unread state. The narrow
indicator above resolves the host's asset-mask element and paints only that
element with the live theme token, while keeping the Inbox label and layout
unchanged. It restores host attributes on zero, redraw, title/region drift,
and unmount cleanup. The branding path does not relax the fail-loud scope:
unknown or ambiguous glyph resolution still reports `Inbox unread indicator
broken`, and the host-DOM exception remains limited to this indicator.

Branding assets are read at plugin load and served by the host. Changing the
asset requires the normal plugin reload boundary; unread count changes never
rewrite the asset itself. When get-bb/bb#1852 supplies a host-owned unread
indicator API, remove this DOM coupling, the indicator poll, its tests, and
this exception section as described by the retirement boundary above.

## Smallest host support that unblocks this

Preferred, and smallest overall — extend the mechanism the host already has,
no plugin API required:

1. A default visible cap on the existing visible/hidden partition, so rows
   past the cap fall into the existing `More (N)` disclosure without the user
   hiding each one by hand.
2. A narrow/compact-viewport default of collapsed for that same region,
   independent of the wide-viewport state.

If BB instead wants this delegated to plugins, the minimum contract is:

1. A stable nav-region identity in the DOM — one region attribute plus one
   per-row key attribute (`data-sidebar-plugin-nav-row-key="<pluginId>/<id>"`),
   published in the authoring guide the way the thread-row shortcut attributes
   already are.
2. A host-owned collapse state and row provider on the app SDK — read the
   visible/hidden partition and the compact-viewport flag, and request a
   visible cap — so the host stays the single writer of
   `bb.sidebar.pluginPanelOrder` / `bb.sidebar.hiddenPluginPanels` and the
   plugin never touches that storage directly.

Either path keeps host row actions, ordering, keyboard navigation, focus,
hover, and theme tokens under host ownership, which is why neither can be
faked from plugin code today.

## Frozen decision carried forward

The visible-row count is **2**, hardcoded, when this is implemented.

<!-- ponytail: two is a constant on purpose. It gets a settings surface only
     once a host nav-provider contract exists to configure against; a plugin
     setting today would configure nothing and would be a second store for
     state the host owns. -->

`tests/sidebar-nav-capability.test.ts` is the tripwire: it asserts the
vendored SDK declarations still expose no nav-region surface, and fails as
soon as BB ships one, which is the signal to reopen this.
