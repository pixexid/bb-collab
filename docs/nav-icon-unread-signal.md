# Can a plugin's own icon carry unread state? Measured: no.

GH-258 item 5 wants an unread count visible before the Inbox panel is opened.
`PluginNavPanelRegistration` has no badge, count, or attention field, and that
is filed upstream as get-bb/bb#1852. This document answers the *other* question:
the plugin directory is plugin-writable, so could a lane rewrite its own icon or
logo file when unread state changes and let the glyph carry the signal?

**No. Plugin branding assets are read once at plugin load and served from
memory. A runtime rewrite changes nothing until the plugin reloads.** Nothing
ships from this lane.

## The measurement

Instrument: a throwaway plugin, `iconprobe`, installed from a local path with
`branding.icon` **and** `branding.logo.{light,dark}` all pointing at
plugin-owned `./assets/*.svg`. Observed at the HTTP layer — `GET
/api/v1/plugins` for the registered URLs, and `GET` on the asset route for the
bytes actually served. Installed, mutated, and removed inside this lane; no
other plugin or checkout was touched.

| | `branding.icon` hash | bytes served at the asset route |
| --- | --- | --- |
| T0 baseline (square glyph on disk) | `da5c6041c6beec2b` | square |
| T1 circle glyph written to disk, **no reload**, +5s | `da5c6041c6beec2b` | **square** |
| T2 same file, after `bb plugin reload iconprobe` | `322e5591f2341d0a` | circle |

`logo` and `logo-dark` moved in lockstep with `icon` at every step — same
negative at T1, same recovery at T2. The logo is not the escape hatch.

T2 is the control, and it is what makes T1 mean something: the same byte
sequence that the server ignored at T1 is picked up at T2, so T1 is the host
declining to re-read, not the probe failing to write.

### What was observed, and what was not

Observed directly: the registered URL's content hash, and the bytes the asset
route returns. Not observed: the rendered glyph by eye.

The visual check is unnecessary rather than skipped. A plugin-owned icon renders
as a `<span>` whose `mask-image` is `url(<iconUrl>)` with
`background-color: currentColor`. At T1 that URL is byte-identical to T0 *and*
the bytes behind it are byte-identical to T0, so there is no path by which the
painted pixels could differ. Measuring the server is strictly stronger here than
looking at the screen.

## Why, from the host

`loadPluginBrandingAssets` runs in `loadOne`/`populateIdentity` — the plugin
load path — and returns, per variant, `{ url, bytes, contentType, hash }` with
the file's bytes **retained in memory** and the hash embedded in the URL as
`?h=<sha256[0:16]>`. `getBrandingAsset` serves that cached buffer. No watcher,
no `stat`, no revalidation. So the mechanism is not merely slow to notice a
rewrite; it never looks again.

This also corrects two earlier readings. `isPluginOwnedIconPath` is
`icon.startsWith("./")`, but the manifest validator separately requires a
`.svg`, `.png`, or `.webp` extension and, for `icon`, that the SVG pass
`assertValidPluginCompactIconSvg` — so the extension constraint is real, just
enforced elsewhere. And `faviconColor` is browser-tab chrome tied to the
webmanifest; no plugin can drive it.

## What `agent-proxy` actually does

Pulled from `smsunarto/bb-plugins`, `plugins/agent-proxy`. Its colour change has
nothing to do with its icon file. `components/sidebar-nav-status.ts` is a
content script that:

1. finds `document.querySelector('[data-testid="plugin-nav-sidebar-items"]')`,
2. locates its own row by matching `button.textContent.trim()` against the
   nav title,
3. sets `data-agent-proxy-state="running" | "crashed" | …` on that button,
4. and lets `app.css` recolour the row's `svg` / `[data-plugin-icon-asset]`
   child via `color:`, polling every 5s.

It works, live, and its own source comment says why it exists: "bb renders that
row itself from the `navPanel` registration — title and icon are read once, and
no slot accepts a live component — so a content script is the only way to
reflect state there." That is independent confirmation of the same boundary this
document measures.

**It does not apply here, and not as a matter of taste.** It is precisely the
combination this repository has already refused twice on the record: the host
`data-testid` nav selector and visible-text row matching
(`docs/sidebar-plugin-nav-collapse.md`, "Why the available hacks are refused"),
restated for this exact region in `docs/issue-63-operator-console.md`, with
`tests/sidebar-nav-capability.test.ts` standing as the tripwire. Adopting it
would also stand up a second mechanism beside the sanctioned
`experimental_setThreadRowStatus` pulse, which the brief for this lane forbids.

There is a second, quieter cost worth recording. Compact chrome prefers the
manifest icon over a contribution's icon, so giving `bb-collab` a plugin-owned
`branding.icon` would collapse the Lanes and Inbox nav rows to the *same* glyph
— the recolour would be bought by making the two rows harder to tell apart.

## Disposition

Reload-scope signalling is not offered. An unread accent that only becomes true
after a plugin reload is a signal that lies for an unbounded interval, and the
operator would have to learn not to trust it — the false affordance the director
ruled worse than an absent one. The upstream gap is already filed as
get-bb/bb#1852 and the operator already knows item 5 is blocked there.

If the operator wants the live nav recolour anyway, the decision to make is not
"does it work" — it does — but whether to overturn the standing refusal of host
`data-testid` selectors and visible-text row matching. That is the operator's
call, not this lane's, and it should be made against the fragility already
catalogued in `docs/sidebar-plugin-nav-collapse.md` rather than against this
measurement.

`tests/sidebar-nav-capability.test.ts` carries the tripwire for the branding
surface: it fails if the SDK ever grows a runtime badge, count, or branding
setter, and that failure is the signal to reopen this, not a regression.
