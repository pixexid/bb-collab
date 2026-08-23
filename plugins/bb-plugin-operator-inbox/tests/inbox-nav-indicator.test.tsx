// @vitest-environment jsdom

import { cleanup, waitFor } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INBOX_INDICATOR_BROKEN_TITLE,
  INBOX_NAV_REGION_SELECTOR,
  INBOX_NAV_ROW_TITLE,
  inspectInboxNavGlyph,
  paintInboxNavUnread,
} from "../src/inbox-nav-indicator";

const MAIL = "M7 8.5L9.94 10.24a4 4 0 0 0 4.11 0L17 8.5";
const GIT_BRANCH = "M7 19h6a3 3 0 0 0 3-3v-6";
const ENVELOPE_ASSET = "./assets/envelope-simple-duotone.svg";

function row(label: string, path: string | null, transform?: string, asset?: string | null): string {
  const glyph = asset === null || asset === undefined
    ? path === null ? "" : `<svg><path d="${path}"${transform === undefined ? "" : ` transform="${transform}"`}/></svg>`
    : `<span data-plugin-icon-asset="${asset}" class="host-asset" style="mask-image:url(${asset})"></span>`;
  return `<button type="button">${glyph}<span>${label}</span></button>`;
}

function navRegion({
  testid = "plugin-nav-sidebar-items",
  inboxLabel = INBOX_NAV_ROW_TITLE,
  inboxGlyph = MAIL as string | null,
  inboxAsset = null as string | null,
  lanesGlyph = null as string | null,
  lanesAsset = null as string | null,
  inboxTransform = undefined as string | undefined,
  extraRows = "",
} = {}): HTMLElement {
  const region = document.createElement("div");
  region.setAttribute("data-testid", testid);
  region.innerHTML = `${row("Lanes", lanesGlyph, undefined, lanesAsset)}${row(inboxLabel, inboxGlyph, inboxTransform, inboxAsset)}${extraRows}`;
  document.body.append(region);
  return region;
}

function inboxRow(): HTMLButtonElement {
  return document.querySelector(`${INBOX_NAV_REGION_SELECTOR} button:nth-of-type(2)`) as HTMLButtonElement;
}

function inboxGlyph(): Element | null {
  return inboxRow().querySelector("[data-plugin-icon-asset]") ?? inboxRow().querySelector("svg");
}

function message(messageId: number, readAtMs: number | null) {
  return {
    messageId,
    projectId: "project-a",
    recipient: "operator" as const,
    senderThreadId: "sender-thread",
    senderLaneId: null,
    severity: "routine" as const,
    text: `message ${messageId}`,
    createdAtMs: messageId,
    readAtMs,
    archivedAtMs: null,
    senderTitle: null,
    repliedAtMs: null,
    replyText: null,
    replyDeliveryError: null,
    replyInProgress: false,
    notificationStatus: "not-requested" as const,
    notificationError: null,
  };
}

type InboxReply = ReturnType<typeof message>[] | { outcome: string; message?: string; messages: ReturnType<typeof message>[] };

// Most cases only care about the rows, so an array is wrapped in the OK
// outcome here; a case that cares about the outcome code returns the result.
function rpcHandlers(operatorMessages: (input: { projectId: string }) => Promise<InboxReply>) {
  return {
    lanes: async () => [],
    threadStates: async () => ({}),
    threadModels: async () => ({}),
    sidebarCollapseState: async () => ({ projects: {}, threads: {} }),
    setSidebarCollapse: async () => ({}),
    reorderPinned: async () => ({ ok: true }),
    setThreadState: async () => ({ state: null }),
    operatorMessages: async (input: { projectId: string }) => {
      const reply = await operatorMessages(input);
      return Array.isArray(reply) ? { outcome: "OK", messages: reply } : reply;
    },
    markOperatorMessageRead: async () => ({}),
    archiveOperatorMessage: async () => ({}),
    replyToOperatorMessage: async () => ({}),
  } as never;
}

async function threadList() {
  installTestPluginRuntime();
  const app = await loadPluginApp(() => import("../app"));
  return app.navPanels.find((panel) => panel.id === "inbox")!;
}

function renderList(operatorMessages: (input: { projectId: string }) => Promise<InboxReply>) {
  return renderSlot(threadListRegistration!, { subPath: "" }, {
    sidebarThreads: { status: "ready", projects: [{ id: "project-a", name: "Project A", isPersonal: false }], threads: [] },
    rpc: rpcHandlers(operatorMessages),
  });
}

let threadListRegistration: Awaited<ReturnType<typeof threadList>> | null = null;

describe("inbox unread nav indicator", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("accents only the Inbox glyph, announces the exact count, and clears at zero", () => {
    // #given
    navRegion();

    // #when
    const painted = paintInboxNavUnread(document, 3);

    // #then
    expect(painted).toEqual({ matched: true });
    expect(inboxGlyph()?.classList.contains("text-primary")).toBe(true);
    expect(inboxRow().getAttribute("aria-label")).toBe("Inbox, 3 unread operator messages");
    expect(inboxRow().getAttribute("title")).toBe("3 unread operator messages");
    expect(document.querySelector("[data-bb-collab-inbox-unread]")).toBeNull();
    expect(inboxRow().textContent).toBe(INBOX_NAV_ROW_TITLE);

    expect(paintInboxNavUnread(document, 0)).toEqual({ matched: true });
    expect(inboxGlyph()?.classList.contains("text-primary")).toBe(false);
    expect(inboxRow().hasAttribute("aria-label")).toBe(false);
    expect(inboxRow().hasAttribute("title")).toBe(false);
    expect(document.querySelector("[data-bb-collab-inbox-unread]")).toBeNull();
  });

  it("restores host attributes and leaves nav label layout untouched", () => {
    // #given
    navRegion({ inboxGlyph: MAIL, lanesGlyph: GIT_BRANCH });
    const row = inboxRow();
    row.setAttribute("aria-label", "Inbox");
    row.setAttribute("title", "Open Inbox");
    inboxGlyph()!.setAttribute("class", "host-glyph");
    inboxGlyph()!.setAttribute("style", "color: inherit");

    // #when / #then
    paintInboxNavUnread(document, 1);
    expect(inboxGlyph()?.classList.contains("text-primary")).toBe(true);
    expect(row.textContent).toBe(INBOX_NAV_ROW_TITLE);
    expect(row.querySelector("[data-bb-collab-inbox-unread]")).toBeNull();
    paintInboxNavUnread(document, 0);
    expect(row.getAttribute("aria-label")).toBe("Inbox");
    expect(row.getAttribute("title")).toBe("Open Inbox");
    expect(inboxGlyph()?.getAttribute("class")).toBe("host-glyph");
    expect(inboxGlyph()?.getAttribute("style")).toBe("color: inherit");
  });

  it("paints asset masks, updates without accumulation, clears exact attrs, and survives unmount", () => {
    // #given the compact host representation: a CSS-mask asset element, not an SVG
    const region = navRegion({ inboxGlyph: null, inboxAsset: ENVELOPE_ASSET, lanesGlyph: GIT_BRANCH });
    const row = inboxRow();
    const asset = inboxGlyph()!;
    const originalClass = asset.getAttribute("class");
    const originalStyle = asset.getAttribute("style");
    const originalChildren = row.children.length;

    // #when / #then
    expect(inspectInboxNavGlyph(document)).toEqual({ matched: true });
    expect(paintInboxNavUnread(document, 2)).toEqual({ matched: true });
    expect(asset.className).toBe("host-asset text-primary");
    expect(row.classList.contains("text-primary")).toBe(false);
    expect(row.lastElementChild?.className).toBe("");
    expect(row.textContent).toBe(INBOX_NAV_ROW_TITLE);
    expect(row.children.length).toBe(originalChildren);
    expect(row.querySelector("[data-bb-collab-inbox-unread]")).toBeNull();
    expect(row.getAttribute("aria-label")).toBe("Inbox, 2 unread operator messages");

    paintInboxNavUnread(document, 4);
    expect(asset.className).toBe("host-asset text-primary");
    expect(row.children.length).toBe(originalChildren);
    expect(row.getAttribute("aria-label")).toBe("Inbox, 4 unread operator messages");

    paintInboxNavUnread(document, 0);
    expect(asset.getAttribute("class")).toBe(originalClass);
    expect(asset.getAttribute("style")).toBe(originalStyle);
    expect(row.hasAttribute("aria-label")).toBe(false);
    expect(row.hasAttribute("title")).toBe(false);

    // #when the host unmounts and remounts its nav subtree
    region.remove();
    expect(document.querySelector(INBOX_NAV_REGION_SELECTOR)).toBeNull();
    navRegion({ inboxGlyph: null, inboxAsset: ENVELOPE_ASSET, lanesGlyph: GIT_BRANCH });
    expect(paintInboxNavUnread(document, 1)).toEqual({ matched: true });
    expect(inboxGlyph()?.className).toBe("host-asset text-primary");
    expect(inboxRow().getAttribute("aria-label")).toBe("Inbox, 1 unread operator message");
    expect(document.querySelector("[data-bb-collab-inbox-unread]")).toBeNull();
  });

  it("fails closed when the Inbox glyph is missing or ambiguous", () => {
    // #given neither supported host representation exists
    navRegion({ inboxGlyph: null, inboxAsset: null });
    const missing = paintInboxNavUnread(document, 1);
    expect(missing.matched).toBe(false);
    expect(missing.matched === false ? missing.reason : "").toContain("neither");

    // #given two asset elements could both be the host-owned glyph
    document.body.innerHTML = "";
    navRegion({ inboxGlyph: null, inboxAsset: ENVELOPE_ASSET, lanesGlyph: GIT_BRANCH });
    inboxRow().insertAdjacentHTML("afterbegin", `<span data-plugin-icon-asset="${ENVELOPE_ASSET}" class="second-asset"></span>`);
    const ambiguous = paintInboxNavUnread(document, 1);
    expect(ambiguous.matched).toBe(false);
    expect(ambiguous.matched === false ? ambiguous.reason : "").toContain("expected exactly 1");
    expect(inboxRow().className).not.toContain("text-primary");
  });

  it("reports broken when the host renames the region test id", () => {
    // #given
    navRegion({ testid: "plugin-nav-sidebar-rows" });

    // #when
    const painted = paintInboxNavUnread(document, 3);

    // #then
    expect(painted.matched).toBe(false);
    expect(painted.matched === false ? painted.reason : "").toContain(INBOX_NAV_REGION_SELECTOR);
    expect(document.querySelector("[data-bb-collab-inbox-unread]")).toBeNull();
  });

  it("reports broken when the host relabels the row", () => {
    // #given
    navRegion({ inboxLabel: "Messages" });

    // #when
    const painted = paintInboxNavUnread(document, 3);

    // #then
    expect(painted.matched).toBe(false);
    expect(painted.matched === false ? painted.reason : "").toContain("0 of the 2 rows");
    expect(document.querySelector("[data-bb-collab-inbox-unread]")).toBeNull();
  });

  it("paints the live unread count from the sidebar poll", async () => {
    // #given
    threadListRegistration = await threadList();
    navRegion();

    // #when
    renderList(async () => [message(1, null), message(2, null), message(3, 5)]);

    // #then
    await waitFor(() => expect(inboxRow().getAttribute("aria-label")).toContain("2 unread operator messages"));
    expect(inboxGlyph()?.classList.contains("text-primary")).toBe(true);
  });

  it("paints nothing when every message is read", async () => {
    // #given
    threadListRegistration = await threadList();
    navRegion();

    // #when
    const operatorMessages = vi.fn(async () => [message(1, 5)]);
    const rendered = renderList(operatorMessages);

    // #then
    await waitFor(() => expect(operatorMessages).toHaveBeenCalledWith({ projectId: "project-a", recipient: "operator" }));
    expect(inboxGlyph()?.classList.contains("text-primary")).toBe(false);
    expect(rendered.queryByRole("alert")).toBeNull();
  });

  it("does not count a schema-valid non-operator row from an operator-filtered response", async () => {
    // #given
    threadListRegistration = await threadList();
    navRegion();
    const hostile = { ...message(1, null), recipient: "supervisor" as const, text: "hostile supervisor indicator row" };

    // #when
    const rendered = renderList(async () => [hostile] as never);

    // #then the panel error also proves the shared response has settled
    await waitFor(() => expect(rendered.getByText(/operator inbox response included a non-operator message/)).toBeTruthy());
    expect(inboxGlyph()?.classList.contains("text-primary")).toBe(false);
  });

  it("surfaces a visible broken state and records the error when the coupling dies", async () => {
    // #given
    threadListRegistration = await threadList();
    navRegion({ inboxLabel: "Messages" });
    const recorded = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // #when
    const rendered = renderList(async () => [message(1, null)]);

    // #then
    await waitFor(() => expect(rendered.getByRole("alert").textContent).toContain(INBOX_INDICATOR_BROKEN_TITLE));
    expect(recorded).toHaveBeenCalledWith(expect.stringContaining(INBOX_INDICATOR_BROKEN_TITLE));
    expect(inboxGlyph()?.classList.contains("text-primary")).toBe(false);
  });
  it("reports broken when a second row is also titled Inbox", () => {
    // #given a valid-but-wrong match: the accent would land on someone else's row
    navRegion({ extraRows: `<button type="button"><span>${INBOX_NAV_ROW_TITLE}</span></button>` });

    // #when
    const painted = paintInboxNavUnread(document, 3);

    // #then
    expect(painted.matched).toBe(false);
    expect(painted.matched === false ? painted.reason : "").toContain("2 of the 3 rows");
    expect(document.querySelector("[data-bb-collab-inbox-unread]")).toBeNull();
  });

  it("accepts distinct row geometry", () => {
    // #given
    navRegion({ inboxGlyph: MAIL, lanesGlyph: GIT_BRANCH });

    // #when / #then
    expect(inspectInboxNavGlyph(document)).toEqual({ matched: true });
  });

  it("reports broken when both rows fall back to the same glyph", () => {
    // #given the failure the icon probe hit: unknown names collapsing onto one default
    navRegion({ inboxGlyph: GIT_BRANCH, lanesGlyph: GIT_BRANCH });

    // #when
    const inspected = inspectInboxNavGlyph(document);

    // #then
    expect(inspected?.matched).toBe(false);
    expect(inspected?.matched === false ? inspected.reason : "").toContain("draw the same glyph");
  });

  it("judges nothing when the rows carry no readable geometry", () => {
    // #given
    navRegion({ inboxGlyph: null, lanesGlyph: null });

    // #when / #then
    expect(inspectInboxNavGlyph(document)).toBeNull();
  });

  it("surfaces the collapsed-glyph death through the live poll", async () => {
    // #given
    threadListRegistration = await threadList();
    navRegion({ inboxGlyph: GIT_BRANCH, lanesGlyph: GIT_BRANCH });
    const recorded = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // #when
    const rendered = renderList(async () => [message(1, null)]);

    // #then
    await waitFor(() => expect(rendered.getByRole("alert").textContent).toContain("draw the same glyph"));
    expect(recorded).toHaveBeenCalledWith(expect.stringContaining(INBOX_INDICATOR_BROKEN_TITLE));
    expect(inboxGlyph()?.classList.contains("text-primary")).toBe(true);
    expect(inboxRow().getAttribute("aria-label")).toContain("1 unread operator message");
  });
  it("stays healthy when the same path data is drawn under a different transform", () => {
    // #given a legitimate re-theme: identical `d`, rotated 90 degrees
    navRegion({ inboxGlyph: GIT_BRANCH, lanesGlyph: GIT_BRANCH, inboxTransform: "rotate(90 12 12)" });

    // #when
    const inspected = inspectInboxNavGlyph(document);

    // #then the switch must not cry wolf
    expect(inspected).toEqual({ matched: true });
  });

  it("keeps a project's last proven unread count when its read fails", async () => {
    // #given a project that answers once and then rejects
    threadListRegistration = await threadList();
    navRegion();
    vi.useFakeTimers();
    let call = 0;
    renderList(async () => {
      call += 1;
      if (call === 1) return [message(1, null), message(2, null)];
      throw new Error("transient");
    });

    // #when the first poll proves 2 unread and the next one fails
    await vi.advanceTimersByTimeAsync(1);
    expect(inboxGlyph()?.classList.contains("text-primary")).toBe(true);
    expect(inboxRow().getAttribute("aria-label")).toContain("2 unread operator messages");
    await vi.advanceTimersByTimeAsync(30_000);

    // #then the proven count survives the failure rather than reading as zero
    expect(call).toBeGreaterThan(1);
    expect(inboxGlyph()?.classList.contains("text-primary")).toBe(true);
  });

  it("counts the unregistered outcome as a proven zero rather than retaining the last count", async () => {
    // #280: an answered read is a proven count. The unregistered outcome carries
    // no rows, so it proves zero without the poll reading any sentence — the
    // message is reworded between polls to make that plain.
    threadListRegistration = await threadList();
    navRegion();
    vi.useFakeTimers();
    const sentences = ["operator inbox project is not registered", "aucune boîte de réception"];
    let call = 0;
    renderList(async () => {
      call += 1;
      if (call === 1) return [message(1, null), message(2, null)];
      return { outcome: "PROJECT_CONFIG_REQUIRED", message: sentences[call % 2]!, messages: [] };
    });

    // #when a proven 2 is followed by two unregistered answers
    await vi.advanceTimersByTimeAsync(1);
    expect(inboxGlyph()?.classList.contains("text-primary")).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);

    // #then the accent is cleared, and stays cleared when the sentence changes
    expect(inboxGlyph()?.classList.contains("text-primary")).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(call).toBeGreaterThan(2);
    expect(inboxGlyph()?.classList.contains("text-primary")).toBe(false);
  });

  it("records the break once rather than on every poll", async () => {
    // #given
    threadListRegistration = await threadList();
    navRegion({ inboxLabel: "Messages" });
    const recorded = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.useFakeTimers();

    // #when the same break is observed on three consecutive polls
    renderList(async () => [message(1, null)]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    // #then only the transition is recorded
    expect(recorded).toHaveBeenCalledTimes(1);
  });
});
