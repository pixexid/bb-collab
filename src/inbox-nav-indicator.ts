// The one sanctioned exception to the host-DOM refusal recorded in
// docs/sidebar-plugin-nav-collapse.md, "Narrow exception: the inbox unread
// indicator" — that section carries the scope and the retirement condition.
// The exception exists because this coupling announces its own death: every
// paint reports whether it matched, and a zero-match is surfaced and logged
// rather than silently painting nothing.

export const INBOX_NAV_REGION_SELECTOR = "[data-testid=\"plugin-nav-sidebar-items\"]";
export const INBOX_NAV_ROW_TITLE = "Inbox";
export const LANES_NAV_ROW_TITLE = "Lanes";
export const INBOX_UNREAD_MARKER = "data-bb-collab-inbox-unread";
export const INBOX_INDICATOR_BROKEN_TITLE = "Inbox unread indicator broken";

// ponytail: inline style, not a class. dist/app.css is generated from tokens
// found in this plugin's own source, so it cannot carry a rule scoped to a
// host-rendered row; a stylesheet would be a second coupling to keep alive.
const DOT_STYLE = "margin-left:auto;flex:0 0 auto;width:0.5rem;height:0.5rem;border-radius:9999px;background-color:currentColor";

// Geometry, never class names: two host icons differ by the shape they draw,
// and the minified class of a host row tells us nothing about which glyph it is.
const GEOMETRY_ATTRIBUTES = ["d", "points", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "width", "height"];

export type InboxNavPaint = { matched: true } | { matched: false; reason: string };

function navRows(root: ParentNode): Element[] | null {
  const region = root.querySelector(INBOX_NAV_REGION_SELECTOR);
  return region === null ? null : Array.from(region.querySelectorAll("button"));
}

function rowsTitled(rows: Element[], title: string): Element[] {
  return rows.filter((row) => row.textContent?.trim() === title);
}

export function paintInboxNavUnread(root: ParentNode, unread: number): InboxNavPaint {
  const rows = navRows(root);
  if (rows === null) {
    return { matched: false, reason: `no element matches ${INBOX_NAV_REGION_SELECTOR}` };
  }
  const matches = rowsTitled(rows, INBOX_NAV_ROW_TITLE);
  if (matches.length !== 1) {
    // Two matches is the wrong-but-plausible death: another plugin's row is
    // titled Inbox too, and the dot would land on a row that is not ours.
    return { matched: false, reason: `${matches.length} of the ${rows.length} rows in ${INBOX_NAV_REGION_SELECTOR} are titled ${JSON.stringify(INBOX_NAV_ROW_TITLE)}, expected exactly 1` };
  }
  const row = matches[0]!;
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

function glyphFingerprint(row: Element): string | null {
  const asset = row.querySelector("[data-plugin-icon-asset]");
  if (asset !== null) return `asset:${asset.getAttribute("data-plugin-icon-asset") ?? ""}`;
  const shapes = Array.from(row.querySelectorAll("svg *"))
    .map((node) => {
      const geometry = GEOMETRY_ATTRIBUTES.flatMap((name) => {
        const value = node.getAttribute(name);
        return value === null ? [] : [`${name}=${value}`];
      });
      return geometry.length === 0 ? "" : `${node.tagName}[${geometry.join(",")}]`;
    })
    .filter((shape) => shape !== "");
  return shapes.length === 0 ? null : shapes.join("|");
}

// The second way this indicator dies: the row is found and the dot is painted,
// but the glyph beside it is not the one Inbox declared — a manifest icon
// overriding it, or an unknown name falling back to the host's default. A
// plugin cannot name the glyph it got, so this reads the control instead: Lanes
// and Inbox declare different icons, so identical geometry is a collapse.
// Returns null when the comparison cannot be made, which is not a failure.
export function inspectInboxNavGlyph(root: ParentNode): InboxNavPaint | null {
  const rows = navRows(root);
  if (rows === null) return null;
  const inbox = rowsTitled(rows, INBOX_NAV_ROW_TITLE);
  const lanes = rowsTitled(rows, LANES_NAV_ROW_TITLE);
  if (inbox.length !== 1 || lanes.length !== 1) return null;
  const inboxGlyph = glyphFingerprint(inbox[0]!);
  const lanesGlyph = glyphFingerprint(lanes[0]!);
  if (inboxGlyph === null || lanesGlyph === null) return null;
  if (inboxGlyph !== lanesGlyph) return { matched: true };
  return { matched: false, reason: `the ${INBOX_NAV_ROW_TITLE} and ${LANES_NAV_ROW_TITLE} rows draw the same glyph (${inboxGlyph}) though they declare different icons` };
}
