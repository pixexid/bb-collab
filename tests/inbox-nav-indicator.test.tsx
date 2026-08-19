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
  paintInboxNavUnread,
} from "../src/inbox-nav-indicator";

function navRegion({ testid = "plugin-nav-sidebar-items", inboxLabel = INBOX_NAV_ROW_TITLE } = {}): HTMLElement {
  const region = document.createElement("div");
  region.setAttribute("data-testid", testid);
  region.innerHTML = `<button type="button"><span>Lanes</span></button><button type="button"><span>${inboxLabel}</span></button>`;
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
    expect(painted.matched === false ? painted.reason : "").toContain("no row of the 2");
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
});
