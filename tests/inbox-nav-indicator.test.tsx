// @vitest-environment jsdom

import { cleanup, waitFor } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";
import type { PluginThreadListProps } from "@bb/plugin-sdk/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INBOX_INDICATOR_BROKEN_TITLE,
  INBOX_NAV_REGION_SELECTOR,
  INBOX_NAV_ROW_TITLE,
  INBOX_UNREAD_MARKER,
  inspectInboxNavGlyph,
  paintInboxNavUnread,
} from "../src/inbox-nav-indicator";

const MAIL = "M7 8.5L9.94 10.24a4 4 0 0 0 4.11 0L17 8.5";
const GIT_BRANCH = "M7 19h6a3 3 0 0 0 3-3v-6";

function row(label: string, path: string | null, transform?: string): string {
  const glyph = path === null ? "" : `<svg><path d="${path}"${transform === undefined ? "" : ` transform="${transform}"`}/></svg>`;
  return `<button type="button">${glyph}<span>${label}</span></button>`;
}

function navRegion({
  testid = "plugin-nav-sidebar-items",
  inboxLabel = INBOX_NAV_ROW_TITLE,
  inboxGlyph = null as string | null,
  lanesGlyph = null as string | null,
  inboxTransform = undefined as string | undefined,
  extraRows = "",
} = {}): HTMLElement {
  const region = document.createElement("div");
  region.setAttribute("data-testid", testid);
  region.innerHTML = `${row("Lanes", lanesGlyph)}${row(inboxLabel, inboxGlyph, inboxTransform)}${extraRows}`;
  document.body.append(region);
  return region;
}

function inboxDot(): Element | null {
  return document.querySelector(`[${INBOX_UNREAD_MARKER}]`);
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
    repliedAtMs: null,
    replyText: null,
    replyDeliveryError: null,
    notificationStatus: "not-requested" as const,
    notificationError: null,
  };
}

function rpcHandlers(operatorMessages: () => Promise<ReturnType<typeof message>[]>) {
  return {
    lanes: async () => [],
    threadStates: async () => ({}),
    threadModels: async () => ({}),
    sidebarCollapseState: async () => ({ projects: {}, threads: {} }),
    setSidebarCollapse: async () => ({}),
    reorderPinned: async () => ({ ok: true }),
    setThreadState: async () => ({ state: null }),
    operatorMessages,
    markOperatorMessageRead: async () => ({}),
    replyToOperatorMessage: async () => ({}),
  } as never;
}

function props(): PluginThreadListProps {
  return { activeThreadId: null, activeProjectId: null, isCompactViewport: false, onNavigate: vi.fn(), searchQuery: "" };
}

async function threadList() {
  installTestPluginRuntime();
  const app = await loadPluginApp(() => import("../app"));
  return app.threadLists[0]!;
}

function renderList(operatorMessages: () => Promise<ReturnType<typeof message>[]>) {
  return renderSlot(threadListRegistration!, props(), {
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

  it("marks the Inbox row when unread is above zero and clears it at zero", () => {
    // #given
    navRegion();

    // #when
    const painted = paintInboxNavUnread(document, 3);

    // #then
    expect(painted).toEqual({ matched: true });
    expect(inboxDot()?.getAttribute(INBOX_UNREAD_MARKER)).toBe("3");
    expect(inboxDot()?.parentElement?.textContent).toContain(INBOX_NAV_ROW_TITLE);

    expect(paintInboxNavUnread(document, 0)).toEqual({ matched: true });
    expect(inboxDot()).toBeNull();
  });

  it("reports broken when the host renames the region test id", () => {
    // #given
    navRegion({ testid: "plugin-nav-sidebar-rows" });

    // #when
    const painted = paintInboxNavUnread(document, 3);

    // #then
    expect(painted.matched).toBe(false);
    expect(painted.matched === false ? painted.reason : "").toContain(INBOX_NAV_REGION_SELECTOR);
    expect(inboxDot()).toBeNull();
  });

  it("reports broken when the host relabels the row", () => {
    // #given
    navRegion({ inboxLabel: "Messages" });

    // #when
    const painted = paintInboxNavUnread(document, 3);

    // #then
    expect(painted.matched).toBe(false);
    expect(painted.matched === false ? painted.reason : "").toContain("0 of the 2 rows");
    expect(inboxDot()).toBeNull();
  });

  it("paints the live unread count from the sidebar poll", async () => {
    // #given
    threadListRegistration = await threadList();
    navRegion();

    // #when
    renderList(async () => [message(1, null), message(2, null), message(3, 5)]);

    // #then
    await waitFor(() => expect(inboxDot()?.getAttribute(INBOX_UNREAD_MARKER)).toBe("2"));
  });

  it("paints nothing when every message is read", async () => {
    // #given
    threadListRegistration = await threadList();
    navRegion();

    // #when
    const operatorMessages = vi.fn(async () => [message(1, 5)]);
    const rendered = renderList(operatorMessages);

    // #then
    await waitFor(() => expect(operatorMessages).toHaveBeenCalledWith({ projectId: "project-a" }));
    expect(inboxDot()).toBeNull();
    expect(rendered.queryByRole("alert")).toBeNull();
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
    expect(inboxDot()).toBeNull();
  });
  it("reports broken when a second row is also titled Inbox", () => {
    // #given a valid-but-wrong match: the dot would land on someone else's row
    navRegion({ extraRows: `<button type="button"><span>${INBOX_NAV_ROW_TITLE}</span></button>` });

    // #when
    const painted = paintInboxNavUnread(document, 3);

    // #then
    expect(painted.matched).toBe(false);
    expect(painted.matched === false ? painted.reason : "").toContain("2 of the 3 rows");
    expect(inboxDot()).toBeNull();
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
    navRegion();

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
    expect(inboxDot()?.getAttribute(INBOX_UNREAD_MARKER)).toBe("1");
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
    expect(inboxDot()?.getAttribute(INBOX_UNREAD_MARKER)).toBe("2");
    await vi.advanceTimersByTimeAsync(30_000);

    // #then the proven count survives the failure rather than reading as zero
    expect(call).toBeGreaterThan(1);
    expect(inboxDot()?.getAttribute(INBOX_UNREAD_MARKER)).toBe("2");
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
