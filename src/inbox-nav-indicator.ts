// The one sanctioned exception to the host-DOM refusal recorded in
// docs/sidebar-plugin-nav-collapse.md, "Narrow exception: the inbox unread
// indicator" — that section carries the scope and the retirement condition.
// The exception exists because this coupling announces its own death: every
// paint reports whether it matched, and a zero-match is surfaced and logged
// rather than silently painting nothing.

export const INBOX_NAV_REGION_SELECTOR = "[data-testid=\"plugin-nav-sidebar-items\"]";
export const INBOX_NAV_ROW_TITLE = "Inbox";
export const INBOX_UNREAD_MARKER = "data-bb-collab-inbox-unread";
export const INBOX_INDICATOR_BROKEN_TITLE = "Inbox unread indicator broken";

// ponytail: inline style, not a class. dist/app.css is generated from tokens
// found in this plugin's own source, so it cannot carry a rule scoped to a
// host-rendered row; a stylesheet would be a second coupling to keep alive.
const DOT_STYLE = "margin-left:auto;flex:0 0 auto;width:0.5rem;height:0.5rem;border-radius:9999px;background-color:currentColor";

export type InboxNavPaint = { matched: true } | { matched: false; reason: string };

export function paintInboxNavUnread(root: ParentNode, unread: number): InboxNavPaint {
  const region = root.querySelector(INBOX_NAV_REGION_SELECTOR);
  if (region === null) {
    return { matched: false, reason: `no element matches ${INBOX_NAV_REGION_SELECTOR}` };
  }
  const rows = Array.from(region.querySelectorAll("button"));
  const row = rows.find((candidate) => candidate.textContent?.trim() === INBOX_NAV_ROW_TITLE);
  if (row === undefined) {
    return { matched: false, reason: `no row of the ${rows.length} in ${INBOX_NAV_REGION_SELECTOR} is titled ${JSON.stringify(INBOX_NAV_ROW_TITLE)}` };
  }
  const existing = row.querySelector(`[${INBOX_UNREAD_MARKER}]`);
  if (unread < 1) {
    existing?.remove();
    return { matched: true };
  }
  const dot = existing ?? row.appendChild(row.ownerDocument.createElement("span"));
  dot.setAttribute(INBOX_UNREAD_MARKER, String(unread));
  dot.setAttribute("aria-hidden", "true");
  dot.setAttribute("title", `${unread} unread operator ${unread === 1 ? "message" : "messages"}`);
  dot.setAttribute("style", DOT_STYLE);
  return { matched: true };
}
