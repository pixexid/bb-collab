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

## The manifest rules, from `pluginBrandingSchema` itself

Three readings circulated during this lane. The schema settles all of them:

```js
pluginBrandingSchema = z.object({
  icon: requiredManifestString.optional(),
  logo: z.object({ light: requiredManifestString, dark: requiredManifestString.optional() })
         .strict().optional(),
}).strict().superRefine((branding, context) => {
  if (branding.icon !== undefined && isPluginOwnedIconPath(branding.icon)
      && !branding.icon.toLowerCase().endsWith(".svg")) {
    context.addIssue({ code: "custom", path: ["icon"],
      message: 'plugin-owned branding.icon paths must point at an .svg file (…)' });
  }
}).refine((branding) => branding.icon !== undefined || branding.logo !== undefined,
  { message: "must declare at least branding.icon or branding.logo.light" });
```

- **A plugin-owned `icon` must be both `./`-prefixed and `.svg`-suffixed.**
  `isPluginOwnedIconPath` really is just `icon.startsWith("./")`, but it is one
  half of a condition, not the rule. Checking the helper is not checking the
  constraint. `.png` and `.webp` are accepted for `logo` only — the wider
  `/\.(svg|png|webp)$/i` in `validatePluginBuildManifest` is a second, looser
  gate applied to all three paths, and the icon-specific `.svg` rule above wins.
- **`icon` and `logo` are additive, not either-or.** The final `refine` is an
  inclusive or — an *at-least-one* requirement, which its own message states:
  "must declare at least branding.icon or branding.logo.light". Nothing forbids
  declaring both. The probe is the proof: `iconprobe` shipped `icon` **and**
  `logo.{light,dark}` in one manifest, installed without complaint, and the
  registry returned non-null `iconUrl`, `logoUrl`, and `logoDarkUrl`
  simultaneously. An either-or rule would have rejected that manifest at install.
  This matters for the test plan: the two surfaces were exercised together in a
  single probe, not as alternative runs, so the T1 negative covers both at once.
- **`faviconColor` is out of reach.** It is browser-tab chrome tied to the
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

## The manifest icon wins, whatever its form — and bb-collab's rows collapse today

This started as a footnote about plugin-owned icons and turned out to be the
finding that explains a live operator complaint, so it is recorded in full.

**Precedence is form-independent.** A plugin's `branding.icon` overrides every
one of its contributions' own icons whether it is a plugin-owned `./` path or a
plain BB icon name. The chain, end to end:

1. The server's `/api/v1/plugins` row builder emits the raw manifest string —
   `icon: loadedPlugin?.manifest.branding.icon ?? identity?.manifest.branding.icon ?? null`
   — with no path-versus-name filtering. Its sibling `iconUrl` is documented
   "Hashed URL when branding.icon declares a plugin-owned compact SVG", so the
   path case has its own field and `icon` carries everything else, names included.
2. The app copies both into a branding store keyed by plugin id.
3. The icon component resolves, after the plugin-owned mask branch, with
   `let c = o?.icon ?? r` — `o.icon` is the manifest string, `r` is the
   contribution's icon. A plain nullish coalesce: the contribution's icon is
   reached **only when the manifest declares none**. There is no `"./"` test.

Every plugin nav row renders through that one component and passes its own
plugin id, so every row of a given plugin resolves to the same manifest icon.
The same component draws the sidebar footer action and the Extensions detail
too — this is not compact-chrome-specific, it is every plugin glyph in the app.

**Measured, not derived.** A throwaway plugin with two nav panels declaring
`Mail` and `GitBranch`, one install, rows read out of the rendered DOM:

| `branding.icon` | ProbeAlpha (`Mail`) | ProbeBeta (`GitBranch`) |
| --- | --- | --- |
| absent (`logo.light` only) | Mail glyph | GitBranch glyph — **distinct** |
| `"Toolbox"` | Toolbox glyph | Toolbox glyph — **collapsed** |

The app bundle was byte-identical across those two rows; only the manifest
changed. The same run read `Lanes` and `Inbox` as **both** rendering GitBranch,
which is `bb-collab`'s `branding.icon`, not `Inbox`'s declared `Mail`.

**So bb-collab's nav rows are already uniform, and the cause is that
`branding.icon` exists — not that its value happens to collide with one row's.**
Changing it from `"GitBranch"` to some other name moves every row to that other
name; it does not restore per-row glyphs.

The only thing that restores them is an absent manifest icon. That has a price:
`pluginBrandingSchema`'s final refine requires at least one of `icon` and
`logo.light`, and this repository declares `branding.icon` alone with no
`assets/` directory, so dropping it means shipping a real `branding.logo.light`
SVG in the same change. That is an asset decision and it is not this lane's to
make.

One incidental confirmation: the probe carried `icon` **and** `logo.light`
together and installed clean, which is the additive rule above observed a second
time.

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
