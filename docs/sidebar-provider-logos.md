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

## The options, and the choice

1. **Ship look-alike artwork.** Rejected: it puts unofficial vendor marks on
   screen and misrepresents Anthropic, OpenAI and Moonshot.
2. **Ship a neutral non-branded glyph per provider.** Rejected: still our
   invention, and it says less than the text already does.
3. **Ship nothing.** Chosen. `shortModelName()` already names the model family
   from the host's own resolved value, and the badge's accessible name carries
   the exact provider id, model and reasoning level the host reported.

## What would unblock real logos

One export on `@bb/plugin-sdk/app` — a `ProviderLogo` component (or a
`useProviderLogo(providerId)` hook) returning BB's own icon and
`ariaLabel`. Then plugin surfaces would render the same official marks the
model selector does, and stay correct when BB adds a provider.

Until then, a tinted model name using BB's published brand colours above is the
nearest honest approximation — it borrows no artwork, only colour. That is a
visual decision for the operator, not one to take unilaterally; it is not
implemented.
