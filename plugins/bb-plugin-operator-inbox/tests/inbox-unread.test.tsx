// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyUnreadMutation, clearUnreadObserver, readOperatorMessagesWithEpoch, refreshUnread, useInboxUnreadCount } from "../src/inbox-unread";

function message(projectId: string, messageId: number, readAtMs: number | null = null) {
  return { messageId, projectId, recipient: "operator" as const, senderThreadId: "sender", senderLaneId: null, severity: "routine" as const, text: "message", createdAtMs: 1, readAtMs, archivedAtMs: null, senderTitle: null, repliedAtMs: null, replyText: null, replyDeliveryError: null, replyInProgress: false, notificationStatus: "not-requested" as const, notificationError: null };
}

function Probe() {
  return <output aria-label="unread count">{useInboxUnreadCount()}</output>;
}

afterEach(() => {
  cleanup();
  clearUnreadObserver();
  vi.useRealTimers();
});

describe("persistent Inbox unread observer", () => {
  it("keeps the accessory callable before the lazy panel mounts and labels the live count", async () => {
    const { loadPluginApp, installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
    installTestPluginRuntime();
    const app = await loadPluginApp(() => import("../app"));
    const inbox = app.navPanels[0]!;
    expect(inbox.experimental_sidebarAccessory).toBeTypeOf("function");
    const operatorMessages = vi.fn(async ({ projectId }: { projectId: string }) => ({ outcome: "OK", messages: [message(projectId, projectId === "project-a" ? 1 : 2)] }));
    const rendered = renderSlot({ component: inbox.experimental_sidebarAccessory! }, {}, {
      sidebarThreads: { status: "ready", projects: [{ id: "project-a", name: "A", isPersonal: false }, { id: "project-b", name: "B", isPersonal: false }], threads: [] },
      rpc: { operatorMessages } as never,
    });

    await waitFor(() => expect(rendered.getByRole("status").getAttribute("aria-label")).toBe("2 unread operator messages"));
    expect(operatorMessages).toHaveBeenCalledTimes(2);
    rendered.lifecycle.unmount();
  });

  it("retains a failed project's proof and subtracts a removed project", async () => {
    const probe = render(<Probe />);
    let failed = false;
    let malformed = false;
    let readA = false;
    const operatorMessages = vi.fn(async ({ projectId }: { projectId: string }) => {
      if (failed && projectId === "project-b") throw new Error("unavailable");
      if (malformed && projectId === "project-b") return { outcome: "OK", messages: [{ ...message(projectId, 2), readAtMs: undefined }] };
      return { outcome: "OK", messages: projectId === "project-a" ? [message(projectId, 1, readA ? 2 : null)] : [message(projectId, 2)] };
    });

    refreshUnread(operatorMessages as never, [{ id: "project-a" }, { id: "project-b" }]);
    await waitFor(() => expect(probe.getByLabelText("unread count").textContent).toBe("2"));
    failed = true;
    readA = true;
    refreshUnread(operatorMessages as never, [{ id: "project-a" }, { id: "project-b" }]);
    await waitFor(() => expect(probe.getByLabelText("unread count").textContent).toBe("1"));
    failed = false;
    malformed = true;
    refreshUnread(operatorMessages as never, [{ id: "project-a" }, { id: "project-b" }]);
    await waitFor(() => expect(probe.getByLabelText("unread count").textContent).toBe("1"));
    refreshUnread(operatorMessages as never, [{ id: "project-a" }]);
    await waitFor(() => expect(probe.getByLabelText("unread count").textContent).toBe("0"));
  });

  it("updates the proven count immediately for read and archive mutations", async () => {
    const probe = render(<Probe />);
    const unread = message("project-a", 1);
    const operatorMessages = vi.fn(async () => ({ outcome: "OK", messages: [unread] }));
    refreshUnread(operatorMessages as never, [{ id: "project-a" }]);
    await waitFor(() => expect(probe.getByLabelText("unread count").textContent).toBe("1"));
    await act(async () => applyUnreadMutation({ ...unread, readAtMs: 2 }));
    expect(probe.getByLabelText("unread count").textContent).toBe("0");
    refreshUnread(operatorMessages as never, [{ id: "project-a" }]);
    await waitFor(() => expect(probe.getByLabelText("unread count").textContent).toBe("1"));
    await act(async () => applyUnreadMutation({ ...unread, archivedAtMs: 3 }));
    expect(probe.getByLabelText("unread count").textContent).toBe("0");
  });

  it("fails closed for a foreign-project operator row", async () => {
    const probe = render(<Probe />);
    const operatorMessages = vi.fn(async () => ({ outcome: "OK", messages: [message("project-b", 1)] }));
    refreshUnread(operatorMessages as never, [{ id: "project-a" }]);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(probe.getByLabelText("unread count").textContent).toBe("0");
  });

  it("does not apply a read that settles after mark-read", async () => {
    const probe = render(<Probe />);
    let resolve!: (value: unknown) => void;
    const pending = new Promise((finish) => { resolve = finish; });
    const unread = message("project-a", 1);
    const operatorMessages = vi.fn(() => pending);
    refreshUnread(operatorMessages as never, [{ id: "project-a" }]);
    await act(async () => { await Promise.resolve(); });
    await act(async () => applyUnreadMutation({ ...unread, readAtMs: 2 }));
    resolve({ outcome: "OK", messages: [unread] });
    await act(async () => { await pending; });
    expect(probe.getByLabelText("unread count").textContent).toBe("0");
  });

  it("does not rejoin or resurrect a removed project's old read", async () => {
    const probe = render(<Probe />);
    let resolveOld!: (value: unknown) => void;
    const oldRead = new Promise((finish) => { resolveOld = finish; });
    const unread = message("project-a", 1);
    const operatorMessages = vi.fn(() => operatorMessages.mock.calls.length === 1 ? oldRead : Promise.resolve({ outcome: "OK", messages: [unread] }));
    refreshUnread(operatorMessages as never, [{ id: "project-a" }]);
    await act(async () => { await Promise.resolve(); });
    refreshUnread(operatorMessages as never, []);
    refreshUnread(operatorMessages as never, [{ id: "project-a" }]);
    await waitFor(() => expect(probe.getByLabelText("unread count").textContent).toBe("1"));
    expect(operatorMessages).toHaveBeenCalledTimes(2);
    resolveOld({ outcome: "OK", messages: [unread] });
    await act(async () => { await oldRead; });
    expect(probe.getByLabelText("unread count").textContent).toBe("1");
  });

  it("does not reuse a pre-clear client read after remount, while overlap shares one read", async () => {
    let resolveOld!: (value: unknown) => void;
    const oldRead = new Promise((finish) => { resolveOld = finish; });
    const unread = message("project-a", 1);
    const oldRpc = { call: vi.fn(() => oldRead) };
    const newRpc = { call: vi.fn(async () => ({ outcome: "OK", messages: [unread] })) };
    refreshUnread(oldRpc as never, [{ id: "project-a" }]);
    const overlap = readOperatorMessagesWithEpoch(oldRpc as never, { projectId: "project-a", recipient: "operator", withSenderTitles: true });
    await act(async () => { await Promise.resolve(); });
    expect(oldRpc.call).toHaveBeenCalledTimes(1);
    clearUnreadObserver();
    refreshUnread(newRpc as never, [{ id: "project-a" }]);
    await waitFor(() => expect(newRpc.call).toHaveBeenCalledTimes(1));
    resolveOld({ outcome: "OK", messages: [unread] });
    await act(async () => { await Promise.all([oldRead, overlap.promise]); });
    expect(newRpc.call).toHaveBeenCalledTimes(1);
  });

  it("shares one settlement-lifetime read across overlapping refreshes", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((finish) => { resolve = finish; });
    const operatorMessages = vi.fn(() => pending);
    refreshUnread(operatorMessages as never, [{ id: "project-a" }]);
    refreshUnread(operatorMessages as never, [{ id: "project-a" }]);
    await act(async () => { await Promise.resolve(); });
    expect(operatorMessages).toHaveBeenCalledTimes(1);
    resolve({ outcome: "OK", messages: [] });
    await act(async () => { await pending; });
  });

  it("cleans the interval and rejects contaminated or malformed responses", async () => {
    vi.useFakeTimers();
    const { loadPluginApp, installTestPluginRuntime, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
    installTestPluginRuntime();
    const app = await loadPluginApp(() => import("../app"));
    const inbox = app.navPanels[0]!;
    const operatorMessages = vi.fn(async () => ({ outcome: "OK", messages: [{ ...message("project-a", 1), recipient: "supervisor" }] }));
    const rendered = renderSlot({ component: inbox.experimental_sidebarAccessory! }, {}, {
      sidebarThreads: { status: "ready", projects: [{ id: "project-a", name: "A", isPersonal: false }], threads: [] },
      rpc: { operatorMessages } as never,
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(operatorMessages).toHaveBeenCalledTimes(1);
    expect(rendered.queryByRole("status")).toBeNull();
    rendered.lifecycle.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(operatorMessages).toHaveBeenCalledTimes(1);
  });
});
