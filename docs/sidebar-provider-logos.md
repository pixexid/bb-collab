# Provider logos in the sidebar: why the badge ships none

The sidebar's execution badge is text only (`Luna·H`, `Opus·MAX`). It used to
carry a small bundled SVG per provider. Those shapes were **invented by us**,
not the vendors' marks and not BB's, so they were removed.

## What BB actually uses

BB resolves an official logo per provider id in its own frontend, alongside
each vendor's brand colour:

| provider id | BB's brand colour |
| --- | --- |
| `codex` | `text-foreground` |
| `claude-code` | `text-[#D97757]` |
| `pi` | `text-[#6D5DFB]` |
| `acp-cursor` | `text-[#111827]` / `text-[#F5F5F5]` dark |

The resolver returns `{ icon, ariaLabel: <provider displayName> }` for those
ids and falls back to a generic ACP glyph otherwise.

## Why a plugin cannot use them

`@bb/plugin-sdk/app` exports exactly three host components — `ThreadChat`,
`Markdown`, and `experimental_NewThreadComposer` — plus hooks. There is no
icon component, no provider-logo helper, and no asset URL for provider marks
in either declaration file.

The resolver does live in the `plugin-sdk-hooks` chunk the host shims for
plugin bundles, but it is exported there only under minified internal aliases,
as part of the app's own shared module graph. Reaching it would mean binding to
undocumented host internals recovered from a minified bundle — the same class
of mistake as the nav-region `data-testid`, and rejected for the same reason.

## The choice: vendor the exact host paths

Reviewed and overruled the earlier "ship nothing" call. Inventing look-alike
shapes is still rejected — it misrepresents the vendors — but shipping no glyph
lost real scanning value. The marks are therefore **copied verbatim** from the
host chunk into `src/provider-marks.ts`:

| provider id | title | viewBox | paths | fillRule |
| --- | --- | --- | --- | --- |
| `codex` | OpenAI | `0 0 24 24` | 1 (1461 chars) | `evenodd` |
| `claude-code` | Claude | `0 0 149 149` | 1 (1903 chars) | — |
| `pi` | Pi | `100 100 600 600` | 2 | `evenodd` |

Source of record: `bb-app@0.37.0`,
`app/dist/assets/plugin-sdk-hooks-CPZOXpqm.js`. Rendered `fill="currentColor"`
so each glyph inherits the row's theme token; nothing is fetched. Aliases
`openai`/`anthropic`/`kimi` resolve to the same marks. A provider BB ships no
mark for renders **no glyph** — never a substitute shape.

`tests/sidebar-visual-contract.test.tsx` fingerprints each path (exact length,
prefix, and Pi's second path in full) and, when the app is installed, asserts
every vendored path still appears byte-for-byte in the host chunk. A refresh
that redraws or re-fits geometry fails those tests instead of silently
shipping an approximation.

## Options considered

1. **Ship look-alike artwork.** Rejected: it puts unofficial vendor marks on
   screen and misrepresents Anthropic, OpenAI and Moonshot.
2. **Ship a neutral non-branded glyph per provider.** Rejected: still our
   invention, and it says less than the text already does.
3. **Ship nothing.** Rejected on review: the badge's accessible name still
   carried the provider id, but the row lost its at-a-glance provider cue.
4. **Vendor BB's exact marks.** Chosen — see above.

## What would unblock real logos

One export on `@bb/plugin-sdk/app` — a `ProviderLogo` component (or a
`useProviderLogo(providerId)` hook) returning BB's own icon and
`ariaLabel`. Then plugin surfaces would render the same official marks the
model selector does, and stay correct when BB adds a provider.

Until then the vendored copies must be refreshed by re-extraction whenever BB
updates, which the byte-for-byte test makes visible rather than silent.

BB's per-provider brand colours (`#D97757` claude-code, `#6D5DFB` pi,
`text-foreground` codex) are deliberately **not** applied: the marks stay
monochrome so they inherit the row's theme token. Say the word if you want the
coloured treatment the model selector uses.
