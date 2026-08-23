// The one sanctioned exception to the host-DOM refusal recorded in
// docs/sidebar-plugin-nav-collapse.md, "Narrow exception: the inbox unread
// indicator" — that section carries the scope and the retirement condition.
// The exception exists because this coupling announces its own death: every
// paint reports whether it matched, and a zero-match is surfaced and logged
// rather than silently painting nothing.

export const INBOX_NAV_REGION_SELECTOR = "[data-testid=\"plugin-nav-sidebar-items\"]";
export const INBOX_NAV_ROW_TITLE = "Inbox";
export const LANES_NAV_ROW_TITLE = "Lanes";
export const INBOX_INDICATOR_BROKEN_TITLE = "Inbox unread indicator broken";

const LEGACY_UNREAD_MARKER = "[data-bb-collab-inbox-unread]";
const navSnapshots = new WeakMap<Element, { ariaLabel: string | null; title: string | null; glyphClass: string | null; glyphStyle: string | null }>();

// Geometry, never class names: two host icons differ by the shape they draw,
// and the minified class of a host row tells us nothing about which glyph it is.
// "Shape" is everything that moves pixels, not just `d` — the same path data
// rotated, translated, scaled or re-framed draws a different glyph, and a
// fingerprint blind to that raises a false alarm on a legitimate re-theme. This
// switch may not cry wolf: it is the retirement signal for get-bb/bb#1852, and
// a signal that fires on noise gets muted.
const RENDERING_ATTRIBUTES = [
  "d", "points", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2", "width", "height",
  "transform", "transform-origin", "style", "viewBox", "preserveAspectRatio", "href", "xlink:href", "offset",
];

export type InboxNavPaint = { matched: true } | { matched: false; reason: string };

function navRows(root: ParentNode): Element[] | null {
  const region = root.querySelector(INBOX_NAV_REGION_SELECTOR);
  return region === null ? null : Array.from(region.querySelectorAll("button"));
}

function rowsTitled(rows: Element[], title: string): Element[] {
  return rows.filter((row) => row.textContent?.trim() === title);
}

function restoreAttribute(element: Element, name: string, value: string | null): void {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

function restoreNavState(row: Element): void {
  row.querySelector(LEGACY_UNREAD_MARKER)?.remove();
  const snapshot = navSnapshots.get(row);
  if (snapshot === undefined) return;
  restoreAttribute(row, "aria-label", snapshot.ariaLabel);
  restoreAttribute(row, "title", snapshot.title);
  const glyph = row.querySelector("svg");
  if (glyph !== null) {
    restoreAttribute(glyph, "class", snapshot.glyphClass);
    restoreAttribute(glyph, "style", snapshot.glyphStyle);
  }
  navSnapshots.delete(row);
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
  if (unread < 1) {
    restoreNavState(row);
    return { matched: true };
  }
  if (!navSnapshots.has(row)) {
    navSnapshots.set(row, {
      ariaLabel: row.getAttribute("aria-label"),
      title: row.getAttribute("title"),
      glyphClass: row.querySelector("svg")?.getAttribute("class") ?? null,
      glyphStyle: row.querySelector("svg")?.getAttribute("style") ?? null,
    });
  }
  row.querySelector(LEGACY_UNREAD_MARKER)?.remove();
  row.querySelector("svg")?.classList.add("text-primary");
  const countLabel = `${unread} unread operator ${unread === 1 ? "message" : "messages"}`;
  const snapshot = navSnapshots.get(row)!;
  row.setAttribute("aria-label", `${snapshot.ariaLabel ?? INBOX_NAV_ROW_TITLE}, ${countLabel}`);
  row.setAttribute("title", `${snapshot.title === null ? "" : `${snapshot.title} — `}${countLabel}`);
  return { matched: true };
}

function glyphFingerprint(row: Element): string | null {
  const asset = row.querySelector("[data-plugin-icon-asset]");
  if (asset !== null) return `asset:${asset.getAttribute("data-plugin-icon-asset") ?? ""}`;
  // The root svg counts: its viewBox and transform re-frame everything under it.
  const shapes = Array.from(row.querySelectorAll("svg, svg *"))
    .map((node) => {
      const geometry = RENDERING_ATTRIBUTES.flatMap((name) => {
        const value = node.getAttribute(name);
        return value === null ? [] : [`${name}=${value}`];
      });
      return geometry.length === 0 ? "" : `${node.tagName}[${geometry.join(",")}]`;
    })
    .filter((shape) => shape !== "");
  return shapes.length === 0 ? null : shapes.join("|");
}

// The second way this indicator dies: the row is found and the accent is painted,
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
