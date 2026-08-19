// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";
import type { PluginSidebarProject, PluginSidebarThread, PluginThreadListProps } from "@bb/plugin-sdk/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../server.js";

function project(id: string, name: string): PluginSidebarProject {
  return { id, name, isPersonal: false };
}

function thread(id: string, projectId: string, updatedAt: number): PluginSidebarThread {
  return {
    id,
    projectId,
    title: id,
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: updatedAt - 1,
    updatedAt,
    lastReadAt: updatedAt,
    latestAttentionAt: updatedAt,
  };
}

function childThread(id: string, projectId: string, parentThreadId: string, updatedAt: number): PluginSidebarThread {
  return { ...thread(id, projectId, updatedAt), parentThreadId, originKind: "fork" };
}

function props(overrides: Partial<PluginThreadListProps> = {}): PluginThreadListProps {
  return {
    activeThreadId: null,
    activeProjectId: null,
    isCompactViewport: false,
    onNavigate: vi.fn(),
    searchQuery: "",
    ...overrides,
  };
}

async function loadedApp() {
  installTestPluginRuntime();
  return loadPluginApp(() => import("../app"));
}

async function registration() {
  const app = await loadedApp();
  return app.threadLists[0]!;
}

type ThreadExecution = { model: string; reasoning: string };

function rpcHandlers(states: Record<string, string> = {}, models: Record<string, ThreadExecution | null> = {}) {
  return {
    lanes: async () => [],
    threadStates: async () => states,
    threadModels: async () => models,
    sidebarCollapseState: async () => ({ projects: {}, threads: {} }),
    setSidebarCollapse: async (input: { kind: "project" | "thread"; id: string; collapsed: boolean }) => input,
    reorderPinned: async () => ({ ok: true }),
    setThreadState: async (input: { threadId: string; state: string | null }) => ({ state: input.state }),
    operatorMessages: async () => [],
    markOperatorMessageRead: async () => ({}),
    replyToOperatorMessage: async () => ({}),
    doctor: async () => ({}) as never,
    export: async () => ({}) as never,
    apply: async () => ({}) as never,
  } as never;
}

describe("replacement thread list", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("keeps path-install app packaging independent from server imports", async () => {
    const appSource = readFileSync(resolve("app.tsx"), "utf8");
    expect(appSource).toMatch(/import\s+type\s+\{\s*rpcContract\s*\}\s+from\s+["']\.\/server["']/);
    expect(appSource).not.toMatch(/import\s+\{[^}]*rpcContract[^}]*\}\s+from\s+["']\.\/server["']/);
    await loadedApp();
  });

  it("keeps the Lane 1 content-script fallback registered", async () => {
    const app = await loadedApp();
    expect(app.contentScripts.map((script) => script.id)).toContain("lane-thread-status");
  });

  it("registers a project-exact Inbox panel and surfaces reply delivery failures", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const operatorMessages = vi.fn(async () => [{
      messageId: 1,
      projectId: "project-a",
      recipient: "operator" as const,
      senderThreadId: "sender-thread",
      senderLaneId: "lane-one",
      severity: "routine" as const,
      text: "Need an answer",
      createdAtMs: 1,
      readAtMs: 2,
      repliedAtMs: null,
      replyText: "retry me",
      replyDeliveryError: "environment deleted",
      notificationStatus: "not-requested" as const,
      notificationError: null,
    }]);
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages } as never,
    });

    await waitFor(() => expect(operatorMessages).toHaveBeenCalledWith({ projectId: "project-a" }));
    fireEvent.change(rendered.getByLabelText("Project"), { target: { value: "project-a" } });
    await waitFor(() => expect(operatorMessages).toHaveBeenCalledWith({ projectId: "project-a" }));
    expect(rendered.getByText("Need an answer")).toBeTruthy();
    expect(rendered.getByText(/Reply delivery failed: environment deleted/)).toBeTruthy();
    expect(rendered.getByRole("heading", { name: "Project A" })).toBeTruthy();
  });

  it("aggregates every project by default, sorts unread first, and filters by project", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const messages = {
      "project-a": [{ messageId: 1, projectId: "project-a", recipient: "operator" as const, senderThreadId: "a", senderLaneId: null, severity: "routine" as const, text: "read A", createdAtMs: 30, readAtMs: 40, repliedAtMs: null, replyText: null, replyDeliveryError: null, notificationStatus: "not-requested" as const, notificationError: null }],
      "project-b": [{ messageId: 2, projectId: "project-b", recipient: "operator" as const, senderThreadId: "b", senderLaneId: null, severity: "urgent" as const, text: "unread B", createdAtMs: 20, readAtMs: null, repliedAtMs: null, replyText: null, replyDeliveryError: null, notificationStatus: "not-requested" as const, notificationError: null }],
    };
    const operatorMessages = vi.fn(async ({ projectId }: { projectId: string }) => messages[projectId as keyof typeof messages] ?? []);
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A"), project("project-b", "Project B")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages } as never,
    });

    await waitFor(() => expect(rendered.getByText("unread B")).toBeTruthy());
    expect(operatorMessages).toHaveBeenCalledTimes(2);
    expect(Array.from(rendered.container.querySelectorAll("article p.my-3")).map((row) => row.textContent)).toEqual(["unread B", "read A"]);
    expect(Array.from(rendered.container.querySelectorAll("article")).map((row) => row.textContent)).toEqual([expect.stringContaining("Project B"), expect.stringContaining("Project A")]);
    fireEvent.change(rendered.getByLabelText("Project"), { target: { value: "project-a" } });
    await waitFor(() => expect(rendered.queryByText("unread B")).toBeNull());
    expect(rendered.getByText("read A")).toBeTruthy();
  });

  it("persists project and recipient filters across panel opens", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const options = {
      sidebarThreads: { status: "ready" as const, projects: [project("project-a", "Project A")], threads: [] },
      rpc: rpcHandlers(),
    };
    const first = renderSlot(inbox, { subPath: "" }, options);
    fireEvent.change(first.getByLabelText("Project"), { target: { value: "project-a" } });
    fireEvent.change(first.getByLabelText("Recipient"), { target: { value: "supervisor" } });
    first.lifecycle.unmount();

    const reopened = renderSlot(inbox, { subPath: "" }, options);
    expect((reopened.getByLabelText("Project") as HTMLSelectElement).value).toBe("project-a");
    expect((reopened.getByLabelText("Recipient") as HTMLSelectElement).value).toBe("supervisor");
  });

  it("falls back to all projects when a persisted project no longer exists", async () => {
    window.localStorage.setItem("bb-collab.inbox-filters", JSON.stringify({ projectId: "deleted-project", recipient: "" }));
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const operatorMessages = vi.fn(async ({ projectId }: { projectId: string }) => [{
      messageId: 5,
      projectId,
      recipient: "operator" as const,
      senderThreadId: "sender-thread",
      senderLaneId: null,
      severity: "routine" as const,
      text: "Visible after deletion",
      createdAtMs: 1,
      readAtMs: null,
      repliedAtMs: null,
      replyText: null,
      replyDeliveryError: null,
      notificationStatus: "not-requested" as const,
      notificationError: null,
    }]);
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages } as never,
    });

    await waitFor(() => expect(rendered.getByText("Visible after deletion")).toBeTruthy());
    expect(operatorMessages).toHaveBeenCalledWith({ projectId: "project-a" });
    expect((rendered.getByLabelText("Project") as HTMLSelectElement).value).toBe("");
  });

  it("navigates the sender thread from its secondary id", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: async () => [{
        messageId: 4,
        projectId: "project-a",
        recipient: "operator" as const,
        senderThreadId: "sender-thread",
        senderLaneId: "lane-one",
        severity: "routine" as const,
        text: "Open my session",
        createdAtMs: 1,
        readAtMs: null,
        repliedAtMs: null,
        replyText: null,
        replyDeliveryError: null,
        notificationStatus: "not-requested" as const,
        notificationError: null,
      }] } as never,
    });

    const sender = await waitFor(() => rendered.getByRole("link", { name: "Open sender session sender-thread" }));
    expect(sender.textContent).toBe("sender-thread");
    expect(rendered.getByText("lane-one ·")).toBeTruthy();
    fireEvent.click(sender);
    expect(rendered.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "sender-thread" });
  });

  it("keeps the inbox mounted when a sender id has a hostile shape", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: async () => [{
        messageId: 6,
        projectId: "project-a",
        recipient: "operator" as const,
        senderThreadId: { unexpected: true },
        senderLaneId: null,
        severity: "routine" as const,
        text: "Inbox remains mounted",
        createdAtMs: 1,
        readAtMs: null,
        repliedAtMs: null,
        replyText: null,
        replyDeliveryError: null,
        notificationStatus: "not-requested" as const,
        notificationError: null,
      } as never] } as never,
    });

    await waitFor(() => expect(rendered.getByText("Inbox remains mounted")).toBeTruthy());
    expect(rendered.queryByRole("link")).toBeNull();
    expect(rendered.getByText("Sender unavailable")).toBeTruthy();
  });

  it("keeps loaded messages visible when another project read fails", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const operatorMessages = vi.fn(async ({ projectId }: { projectId: string }) => {
      if (projectId === "project-b") throw new Error("project unavailable");
      return [{ messageId: 3, projectId, recipient: "operator" as const, senderThreadId: "a", senderLaneId: null, severity: "routine" as const, text: "loaded A", createdAtMs: 1, readAtMs: null, repliedAtMs: null, replyText: null, replyDeliveryError: null, notificationStatus: "not-requested" as const, notificationError: null }];
    });
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A"), project("project-b", "Project B")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages } as never,
    });

    await waitFor(() => expect(rendered.getByText("loaded A")).toBeTruthy());
    expect(rendered.getByText(/Unable to read inbox: Project B \(project-b\): Error: project unavailable/)).toBeTruthy();
  });

  it("skips unregistered projects silently while a genuine read failure keeps its scoped error", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const operatorMessages = vi.fn(async ({ projectId }: { projectId: string }) => {
      if (projectId === "project-b") throw new Error("operator inbox project is not registered");
      if (projectId === "project-c") throw new Error("project unavailable");
      return [{ messageId: 7, projectId, recipient: "operator" as const, senderThreadId: "a", senderLaneId: null, severity: "routine" as const, text: "loaded A", createdAtMs: 1, readAtMs: null, repliedAtMs: null, replyText: null, replyDeliveryError: null, notificationStatus: "not-requested" as const, notificationError: null }];
    });
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A"), project("project-b", "Project B"), project("project-c", "Project C")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages } as never,
    });

    await waitFor(() => expect(rendered.getByText("loaded A")).toBeTruthy());
    expect(rendered.getByText(/Unable to read inbox: Project C \(project-c\): Error: project unavailable/)).toBeTruthy();
    expect(rendered.queryByText(/not registered/)).toBeNull();
    expect(rendered.queryByText(/Unable to read inbox: Project B/)).toBeNull();
    expect(rendered.container.querySelectorAll("p.text-destructive")).toHaveLength(1);
  });

  it("binds the skip to the rejection the server itself produces, and only in aggregate mode", async () => {
    const host = createFakePluginHost({ pluginId: "bb-collab" });
    await plugin(host.bb);
    // The rejection is taken from the running server rather than authored here:
    // reword the throw at server.ts:794, or wrap the sentinel as the cause of
    // another Error, and this stops matching — the error becomes visible
    // instead of the skip silently over-reaching. A change of THROWN TYPE does
    // not break it: createFakePluginHost canonicalises every handler rejection
    // through errorMessage() and rethrows a new Error, so a non-Error throw
    // reaches the panel as an Error carrying the sentinel. Closing that case
    // needs a domain code rather than a message (#280).
    const serverRejection = await host.harness.callRpc("operatorMessages", { projectId: "project-b" }).then(() => null, (error: unknown) => error);
    expect(serverRejection).toBeInstanceOf(Error);

    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const options = {
      sidebarThreads: { status: "ready" as const, projects: [project("project-b", "Project B")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: async () => { throw serverRejection; } } as never,
    };

    const aggregate = renderSlot(inbox, { subPath: "" }, options);
    await waitFor(() => expect(aggregate.getByText("No messages for this project and recipient filter.")).toBeTruthy());
    expect(aggregate.container.querySelectorAll("p.text-destructive")).toHaveLength(0);

    fireEvent.change(aggregate.getByLabelText("Project"), { target: { value: "project-b" } });
    await waitFor(() => expect(aggregate.getByText(/Unable to read inbox: Project B \(project-b\): Error: operator inbox project is not registered/)).toBeTruthy());
  });

  it("keeps a failure that merely quotes the unregistered sentence visible", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-b", "Project B")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: async () => { throw new Error("transport failed after operator inbox project is not registered response"); } } as never,
    });

    await waitFor(() => expect(rendered.getByText(/Unable to read inbox: Project B \(project-b\): Error: transport failed after operator inbox project is not registered response/)).toBeTruthy());
  });

  it("headers the card with the project name and not its raw id", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("proj_a8zzfsx36j", "bb-collab")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: async () => [{ messageId: 8, projectId: "proj_a8zzfsx36j", recipient: "operator" as const, senderThreadId: "a", senderLaneId: null, severity: "routine" as const, text: "header check", createdAtMs: 1, readAtMs: null, repliedAtMs: null, replyText: null, replyDeliveryError: null, notificationStatus: "not-requested" as const, notificationError: null }] } as never,
    });

    await waitFor(() => expect(rendered.getByText("header check")).toBeTruthy());
    const card = rendered.container.querySelector("article")!;
    expect(card.textContent).toContain("bb-collab");
    expect(card.textContent).not.toContain("proj_a8zzfsx36j");
    expect(rendered.getByRole("heading", { name: "All projects" })).toBeTruthy();
  });

  it("confirms a delivered reply and a mark-read with visible success feedback", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const message = { messageId: 9, projectId: "project-a", recipient: "operator" as const, senderThreadId: "a", senderLaneId: null, severity: "routine" as const, text: "answer me", createdAtMs: 1, readAtMs: null, repliedAtMs: null, replyText: null, replyDeliveryError: null, notificationStatus: "not-requested" as const, notificationError: null };
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: {
        ...(rpcHandlers() as unknown as Record<string, unknown>),
        operatorMessages: async () => [message],
        markOperatorMessageRead: async () => ({ ...message, readAtMs: 5 }),
        replyToOperatorMessage: async () => ({ ...message, readAtMs: 5, repliedAtMs: 6, replyText: "on it" }),
      } as never,
    });

    await waitFor(() => expect(rendered.getByText("answer me")).toBeTruthy());
    fireEvent.click(rendered.getByRole("button", { name: "Mark read" }));
    await waitFor(() => expect(rendered.getByRole("status").textContent).toBe("Marked read."));

    fireEvent.change(rendered.getByLabelText("Reply"), { target: { value: "on it" } });
    fireEvent.click(rendered.getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(rendered.getByRole("status").textContent).toBe("Reply delivered."));
  });

  it("discloses and caps the aggregate display spill", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const messages = Array.from({ length: 257 }, (_, index) => ({ messageId: index + 1, projectId: "project-a", recipient: "operator" as const, senderThreadId: "sender", senderLaneId: null, severity: "routine" as const, text: `message ${index + 1}`, createdAtMs: 257 - index, readAtMs: 1, repliedAtMs: null, replyText: null, replyDeliveryError: null, notificationStatus: "not-requested" as const, notificationError: null }));
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: async () => messages } as never,
    });

    await waitFor(() => expect(rendered.getByText("message 1")).toBeTruthy());
    expect(rendered.container.querySelectorAll("article")).toHaveLength(256);
    expect(rendered.getByText("Showing the first 256 of 257 messages; unread messages are first. Select a project to narrow the list.")).toBeTruthy();
    expect(rendered.queryByText("message 257")).toBeNull();
  });

  it("groups by stable project id and limits each project to five recent threads", async () => {
    const list = await registration();
    const threads = Array.from({ length: 6 }, (_, index) => thread(`project-a-${index + 1}`, "project-a", index + 1));
    threads.push(thread("project-b-1", "project-b", 1));
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A"), project("project-b", "Project B")], threads },
      rpc: rpcHandlers(),
    });

    expect(rendered.getByText("Project A")).toBeTruthy();
    expect(rendered.getByText("Project B")).toBeTruthy();
    expect(rendered.getByText("project-a-6")).toBeTruthy();
    expect(rendered.getByText("project-a-2")).toBeTruthy();
    expect(rendered.queryByText("project-a-1")).toBeNull();
    expect(rendered.getByRole("button", { name: "Show more (1)" })).toBeTruthy();
  });

  it("preserves host order for pinned rows even when updatedAt disagrees", async () => {
    const list = await registration();
    const hostOrder = [
      { ...thread("pinned-first", "project-a", 1), isPinned: true },
      { ...thread("pinned-second", "project-a", 2), isPinned: true },
    ];
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: hostOrder },
      rpc: rpcHandlers(),
    });

    expect(Array.from(rendered.container.querySelectorAll<HTMLElement>("[data-sidebar-thread-id]")).map((row) => row.dataset.sidebarThreadId)).toEqual(["pinned-first", "pinned-second"]);
  });

  it("expands one project without changing other project groups", async () => {
    const list = await registration();
    const threads = Array.from({ length: 6 }, (_, index) => thread(`project-a-${index + 1}`, "project-a", index + 1));
    threads.push(thread("project-b-1", "project-b", 1));
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A"), project("project-b", "Project B")], threads },
      rpc: rpcHandlers(),
    });

    fireEvent.click(rendered.getByRole("button", { name: "Show more (1)" }));
    expect(rendered.getByText("project-a-1")).toBeTruthy();
    expect(rendered.getByText("project-b-1")).toBeTruthy();
    expect(rendered.getByRole("button", { name: "Show less" })).toBeTruthy();
  });

  it("matches the native row actions and routes them to host actions", async () => {
    const list = await registration();
    const pinned = { ...thread("thread-1", "project-a", 1), isPinned: true, isUnread: true };
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [pinned] },
      rpc: rpcHandlers(),
    });
    fireEvent.click(rendered.getByRole("button", { name: "Thread actions" }));
    expect(rendered.getByRole("menu")).toBeTruthy();
    expect(rendered.getByRole("menuitem", { name: "Open in split" })).toBeTruthy();
    expect(rendered.getByRole("menuitem", { name: "Mark read" })).toBeTruthy();
    expect(rendered.getByRole("menuitem", { name: "Unpin" })).toBeTruthy();
    expect(rendered.getByRole("menuitem", { name: "Rename" })).toBeTruthy();
    expect(rendered.getByRole("menuitem", { name: "Archive" })).toBeTruthy();
    expect(rendered.getByRole("menuitem", { name: "Delete" })).toBeTruthy();
    fireEvent.click(rendered.getByRole("menuitem", { name: "Open in split" }));
    expect(rendered.inspection.sidebarActionCalls).toContainEqual({ method: "open", threadId: "thread-1", options: { split: true } });
    fireEvent.click(rendered.getByRole("button", { name: "Thread actions" }));
    fireEvent.click(rendered.getByRole("menuitem", { name: "Mark read" }));
    expect(rendered.inspection.sidebarActionCalls).toContainEqual({ method: "setRead", threadId: "thread-1", read: true });
  });

  it("renders the row actions as a compact stacked dropdown that closes on Escape", async () => {
    const list = await registration();
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [thread("thread-1", "project-a", 1)] },
      rpc: rpcHandlers(),
    });
    const trigger = rendered.getByRole("button", { name: "Thread actions" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(trigger);

    const menu = rendered.getByRole("menu");
    expect(menu.className).toContain("flex-col");
    expect(menu.className).toContain("w-44");
    expect(menu.className).toContain("absolute");
    const items = rendered.getAllByRole("menuitem");
    expect(items).toHaveLength(6);
    expect(items.every((item) => item.className.includes("w-full") && item.className.includes("h-7"))).toBe(true);
    expect(items.at(-1)!.className).toContain("text-destructive");
    expect(rendered.getByRole("separator")).toBeTruthy();

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(rendered.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("routes the destructive action through the host delete confirmation", async () => {
    const list = await registration();
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [thread("thread-1", "project-a", 1)] },
      rpc: rpcHandlers(),
    });
    fireEvent.click(rendered.getByRole("button", { name: "Thread actions" }));
    fireEvent.click(rendered.getByRole("menuitem", { name: "Delete" }));
    expect(rendered.inspection.sidebarActionCalls).toContainEqual({ method: "requestDelete", threadId: "thread-1" });
  });

  it("renders resolved running, attention, idle, and pending signals", async () => {
    const { threadSignal } = await import("../app");
    expect(threadSignal({ ...thread("running", "p", 1), activity: { workflows: 1, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 }, indicatorLabel: "Thread is working" })).toEqual({ kind: "running", label: "Thread is working" });
    expect(threadSignal({ ...thread("attention", "p", 1), indicator: "unread-error", indicatorLabel: "Thread failed" })).toEqual({ kind: "attention", label: "Thread failed" });
    expect(threadSignal(thread("idle", "p", 1)).kind).toBe("idle");
    expect(threadSignal({ ...thread("pending", "p", 1), hasPendingInteraction: true, indicatorLabel: "Thread needs user input" })).toEqual({ kind: "pending", label: "Thread needs user input" });
  });

  it("signals state through colour alone on one native-sized dot", async () => {
    const list = await registration();
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [
        { ...thread("running", "project-a", 4), indicator: "workflow", indicatorLabel: "Thread is working" },
        { ...thread("pending", "project-a", 3), hasPendingInteraction: true },
        { ...thread("failed", "project-a", 2), indicator: "unread-error", indicatorLabel: "Thread failed" },
        thread("idle", "project-a", 1),
      ] },
      rpc: rpcHandlers(),
    });
    const slotOf = (kind: string) => rendered.container.querySelector(`[data-sidebar-thread-signal="${kind}"]`)! as HTMLElement;

    // Working rows get the spinner; unread/attention rows get the dot. One slot,
    // never both glyphs, and an idle read row draws nothing at all.
    expect(slotOf("running").querySelector("[data-sidebar-thread-spinner]")).toBeTruthy();
    expect(slotOf("running").querySelector("[data-sidebar-thread-dot]")).toBeNull();
    for (const kind of ["pending", "attention"]) {
      expect(slotOf(kind).querySelector("[data-sidebar-thread-dot]")).toBeTruthy();
      expect(slotOf(kind).querySelector("[data-sidebar-thread-spinner]")).toBeNull();
    }
    expect(rendered.container.querySelector('[data-sidebar-thread-signal="idle"]')).toBeNull();

    // Dot colour still carries the distinction, at the native 5px geometry.
    expect(slotOf("pending").querySelector("[data-sidebar-thread-dot]")!.className).toContain("bg-primary");
    expect(slotOf("attention").querySelector("[data-sidebar-thread-dot]")!.className).toContain("bg-destructive");
    for (const kind of ["pending", "attention"]) {
      const dot = slotOf(kind).querySelector("[data-sidebar-thread-dot]")! as HTMLElement;
      expect(dot.className).toContain("size-[5px]");
      expect(dot.className).not.toMatch(/animate-/u);
      expect(dot.childElementCount).toBe(0);
    }
    expect(slotOf("running").querySelector("[data-sidebar-thread-spinner]")!.getAttribute("aria-label")).toBe("Thread is working");
    // The indicator label is its own state, not part of the row link's name.
    expect(rendered.getByRole("link", { name: "running" })).toBeTruthy();
  });

  it("leads the row with the spinner when working and with the title otherwise", async () => {
    const list = await registration();
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [
        { ...thread("running", "project-a", 2), indicator: "workflow", indicatorLabel: "Thread is working" },
        thread("still", "project-a", 1),
      ] },
      rpc: rpcHandlers(),
    });

    // Working: the spinner sits to the left of the session name.
    const running = rendered.container.querySelector<HTMLAnchorElement>('[data-sidebar-thread-id="running"]')!;
    const lead = running.previousElementSibling!;
    expect(lead.getAttribute("data-sidebar-thread-signal")).toBe("running");
    expect(lead.querySelector("[data-sidebar-thread-spinner]")).toBeTruthy();

    // Otherwise the title leads: no icon, no dot, no placeholder box holding
    // the space one used to occupy.
    const still = rendered.container.querySelector<HTMLAnchorElement>('[data-sidebar-thread-id="still"]')!;
    expect(still.previousElementSibling).toBeNull();
    expect(still.parentElement!.firstElementChild).toBe(still);
  });

  it("maps host model and reasoning facts to short badge text with safe fallbacks", async () => {
    const { shortModelName, reasoningLetter, executionBadgeLabel } = await import("../app");

    expect(shortModelName("gpt-5.6-luna")).toBe("Luna");
    expect(shortModelName("gpt-5.6-sol")).toBe("Sol");
    expect(shortModelName("claude-opus-5[1m]")).toBe("Opus");
    expect(shortModelName("kimi-k3")).toBe("Kimi");
    expect(shortModelName("claude-fable-5")).toBe("Fable");
    expect(shortModelName("claude-sonnet-5")).toBe("Sonnet");
    expect(shortModelName("gpt-5.5")).toBe("GPT");
    // Unknown families still read as the host's own first word, never a guess.
    expect(shortModelName("mistral-large-2")).toBe("Mistral");
    expect(shortModelName("openai/o9-preview")).toBe("O9");
    expect(shortModelName(null)).toBe("—");

    expect(["low", "medium", "high", "xhigh", "max"].map(reasoningLetter)).toEqual(["L", "M", "H", "X", "MAX"]);
    // Never invent a level the host did not supply, and never letter one that
    // has no letter.
    expect(reasoningLetter(null)).toBe("–");
    expect(reasoningLetter("none")).toBe("–");
    expect(reasoningLetter("ultracode")).toBe("–");
    expect(executionBadgeLabel("codex", null)).toBe("codex · model unavailable · reasoning unavailable");
    expect(executionBadgeLabel("codex", { model: "gpt-5.6-luna", reasoning: "high" })).toBe("codex · model gpt-5.6-luna · reasoning high");
  });

  it("renders the execution badge as the official mark plus short text", async () => {
    const list = await registration();
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [thread("thread-1", "project-a", 1)] },
      rpc: rpcHandlers({}, { "thread-1": { model: "gpt-5.6-luna", reasoning: "high" } }),
    });

    const badge = await waitFor(() => rendered.getByRole("img", { name: "codex · model gpt-5.6-luna · reasoning high" }));
    expect(badge.textContent).toBe("Luna·H");
    // No long provider/model text survives in the row.
    expect(rendered.queryByText("codex/gpt-5.6-luna")).toBeNull();
    // The glyph beside the text is BB's own official mark, vendored verbatim —
    // never a look-alike we drew, and never fetched.
    const mark = badge.querySelector("svg[data-provider-mark]")!;
    expect(mark.getAttribute("data-provider-mark")).toBe("codex");
    expect(mark.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(mark.getAttribute("fill")).toBe("currentColor");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(mark.outerHTML).not.toMatch(/https?:|url\(|#[0-9a-f]{3,6}\b|rgb\(/iu);
    expect(rendered.container.querySelector("img, image, use")).toBeNull();
  });

  it("gives the project counter the same typography as the project name", async () => {
    const list = await registration();
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [thread("thread-1", "project-a", 1)] },
      rpc: rpcHandlers(),
    });
    const name = rendered.getByText("Project A");
    const counter = rendered.container.querySelector<HTMLElement>("[data-project-thread-count]")!;
    expect(counter.textContent).toBe("1");
    // Both inherit the header's type: neither carries a size, weight, colour or
    // numeral utility the other lacks.
    expect(counter.parentElement).toBe(name.parentElement);
    const typography = /^(text-|font-|leading-|tracking-|tabular-|slashed-|lining-|oldstyle-|proportional-)/u;
    const typeClassesOf = (element: HTMLElement) => element.className.split(/\s+/u).filter((token) => typography.test(token));
    expect(typeClassesOf(counter)).toEqual(typeClassesOf(name));
    expect(typeClassesOf(counter)).toEqual([]);
  });

  it("keeps rows and project headers at the native compact height", async () => {
    const list = await registration();
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [thread("thread-1", "project-a", 1)] },
      rpc: rpcHandlers(),
    });
    const row = rendered.container.querySelector('[data-sidebar-thread-id="thread-1"]')!.closest("div")!;
    expect(row.className).toContain("h-7");
    expect(row.className).toContain("transition-colors");
    expect(row.className).toContain("motion-reduce:transition-none");
    expect(rendered.getByText("Project A").parentElement!.className).toContain("h-6");
  });

  it("cross-fades the row actions instead of reflowing the row on hover", async () => {
    const list = await registration();
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [thread("thread-1", "project-a", 1)] },
      rpc: rpcHandlers(),
    });
    const trigger = rendered.getByRole("button", { name: "Thread actions" });
    const meta = trigger.parentElement!.firstElementChild!;
    // A row that reflows on hover moves whatever the pointer was aiming at.
    expect(trigger.className).toContain("absolute");
    expect(meta.className).toContain("group-hover/row:opacity-0");
    expect(meta.className).not.toContain("hidden");
  });

  it("keeps parent threads nested with independently collapsible children", async () => {
    const list = await registration();
    const { buildThreadTree } = await import("../app");
    const root = thread("root", "project-a", 2);
    const child = childThread("child", "project-a", "root", 1);
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [root, child] },
      rpc: rpcHandlers(),
    });
    expect(buildThreadTree([root, child])[0]?.children[0]?.thread.id).toBe("child");
    expect(rendered.getByText("child")).toBeTruthy();
    fireEvent.click(rendered.getByRole("button", { name: "Collapse root children" }));
    expect(rendered.queryByText("child")).toBeNull();
    fireEvent.click(rendered.getByRole("button", { name: "Expand root children" }));
    expect(rendered.getByText("child")).toBeTruthy();
  });

  it("persists project collapse and preserves five top-level rows plus Show more", async () => {
    const list = await registration();
    const threads = Array.from({ length: 6 }, (_, index) => thread(`root-${index + 1}`, "project-a", index + 1));
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads },
      rpc: rpcHandlers(),
    });
    expect(rendered.getByRole("button", { name: "Show more (1)" })).toBeTruthy();
    expect(rendered.queryByText("root-1")).toBeNull();
    fireEvent.click(rendered.getByRole("button", { name: "Collapse Project A section" }));
    expect(rendered.queryByText("root-6")).toBeNull();
    fireEvent.click(rendered.getByRole("button", { name: "Expand Project A section" }));
    expect(rendered.getByRole("button", { name: "Show more (1)" })).toBeTruthy();
  });

  it("has no ambiguous plus or spawn-child affordance and exposes shortcut anchors", async () => {
    const list = await registration();
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [thread("thread-1", "project-a", 1)] },
      rpc: rpcHandlers(),
    });
    expect(rendered.queryByText("+")).toBeNull();
    expect(rendered.queryByRole("button", { name: /spawn child/i })).toBeNull();
    expect(rendered.container.querySelector('[data-sidebar-thread-shortcut-target][data-sidebar-thread-id="thread-1"]')).toBeTruthy();
  });

  it("leaves pinned rows undraggable so the pointer gesture is never swallowed", async () => {
    const list = await registration();
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [{ ...thread("pinned-1", "project-a", 1), isPinned: true }] },
      rpc: rpcHandlers(),
    });
    // A draggable row anchor starts a native HTML5 drag on the first pointermove,
    // which swallows the rest of the pointer stream and strands the reorder.
    const anchor = rendered.container.querySelector<HTMLAnchorElement>('[data-sidebar-thread-id="pinned-1"]')!;
    expect(anchor.draggable).toBe(false);
    expect(anchor.getAttribute("draggable")).toBe("false");
  });

  it("sends typed pinned reorder args for a downward pointer drag", async () => {
    const list = await registration();
    const first = { ...thread("pinned-1", "project-a", 3), isPinned: true };
    const second = { ...thread("pinned-2", "project-a", 2), isPinned: true };
    const third = { ...thread("pinned-3", "project-a", 1), isPinned: true };
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [first, second, third] },
      rpc: rpcHandlers(),
    });
    fireEvent.pointerDown(rendered.container.querySelector('[data-sidebar-thread-id="pinned-1"]')!, { button: 0 });
    fireEvent.pointerUp(rendered.container.querySelector('[data-sidebar-thread-id="pinned-2"]')!, { button: 0 });
    await waitFor(() => expect(rendered.inspection.rpcCalls).toContainEqual({
      method: "reorderPinned",
      input: { threadId: "pinned-1", previousThreadId: "pinned-2", nextThreadId: "pinned-3" },
    }));
  });

  it("sends typed pinned reorder args for an upward pointer drag", async () => {
    const list = await registration();
    const first = { ...thread("pinned-1", "project-a", 3), isPinned: true };
    const second = { ...thread("pinned-2", "project-a", 2), isPinned: true };
    const third = { ...thread("pinned-3", "project-a", 1), isPinned: true };
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [first, second, third] },
      rpc: rpcHandlers(),
    });
    fireEvent.pointerDown(rendered.container.querySelector('[data-sidebar-thread-id="pinned-3"]')!, { button: 0 });
    fireEvent.pointerUp(rendered.container.querySelector('[data-sidebar-thread-id="pinned-1"]')!, { button: 0 });
    await waitFor(() => expect(rendered.inspection.rpcCalls).toContainEqual({
      method: "reorderPinned",
      input: { threadId: "pinned-3", previousThreadId: null, nextThreadId: "pinned-1" },
    }));
  });

  it("commits the row the pointer last crossed when the release misses a row", async () => {
    const list = await registration();
    const first = { ...thread("pinned-1", "project-a", 2), isPinned: true };
    const second = { ...thread("pinned-2", "project-a", 1), isPinned: true };
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [first, second] },
      rpc: rpcHandlers(),
    });
    fireEvent.pointerDown(rendered.container.querySelector('[data-sidebar-thread-id="pinned-1"]')!, { button: 0 });
    fireEvent.pointerEnter(rendered.container.querySelector('[data-sidebar-thread-id="pinned-2"]')!.closest("div")!);
    fireEvent.pointerUp(document.body, { button: 0 });
    await waitFor(() => expect(rendered.inspection.rpcCalls).toContainEqual({
      method: "reorderPinned",
      input: { threadId: "pinned-1", previousThreadId: "pinned-2", nextThreadId: null },
    }));
  });

  it("scopes pinned neighbours to the row's own project group", async () => {
    const list = await registration();
    const rendered = renderSlot(list, props(), {
      sidebarThreads: {
        status: "ready",
        projects: [project("project-a", "Project A"), project("project-b", "Project B")],
        threads: [
          { ...thread("b-pinned", "project-b", 4), isPinned: true },
          { ...thread("a-pinned-1", "project-a", 3), isPinned: true },
          { ...thread("a-pinned-2", "project-a", 2), isPinned: true },
        ],
      },
      rpc: rpcHandlers(),
    });
    fireEvent.pointerDown(rendered.container.querySelector('[data-sidebar-thread-id="a-pinned-2"]')!, { button: 0 });
    fireEvent.pointerUp(rendered.container.querySelector('[data-sidebar-thread-id="a-pinned-1"]')!, { button: 0 });
    // Not "b-pinned": a neighbour from another group is one the user never saw.
    await waitFor(() => expect(rendered.inspection.rpcCalls).toContainEqual({
      method: "reorderPinned",
      input: { threadId: "a-pinned-2", previousThreadId: null, nextThreadId: "a-pinned-1" },
    }));
  });

  it("ignores a pinned drag that crosses project groups", async () => {
    const list = await registration();
    const rendered = renderSlot(list, props(), {
      sidebarThreads: {
        status: "ready",
        projects: [project("project-a", "Project A"), project("project-b", "Project B")],
        threads: [
          { ...thread("a-pinned", "project-a", 2), isPinned: true },
          { ...thread("b-pinned", "project-b", 1), isPinned: true },
        ],
      },
      rpc: rpcHandlers(),
    });
    fireEvent.pointerDown(rendered.container.querySelector('[data-sidebar-thread-id="a-pinned"]')!, { button: 0 });
    fireEvent.pointerUp(rendered.container.querySelector('[data-sidebar-thread-id="b-pinned"]')!, { button: 0 });
    expect(rendered.inspection.rpcCalls.filter((call) => call.method === "reorderPinned")).toEqual([]);
  });

  it("does not reorder from a plain click or from an unpinned row", async () => {
    const list = await registration();
    const pinned = { ...thread("pinned-1", "project-a", 2), isPinned: true };
    const loose = thread("loose-1", "project-a", 1);
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [pinned, loose] },
      rpc: rpcHandlers(),
    });
    const pinnedRow = rendered.container.querySelector('[data-sidebar-thread-id="pinned-1"]')!;
    const looseRow = rendered.container.querySelector('[data-sidebar-thread-id="loose-1"]')!;
    fireEvent.pointerDown(pinnedRow, { button: 0 });
    fireEvent.pointerUp(pinnedRow, { button: 0 });
    fireEvent.pointerDown(looseRow, { button: 0 });
    fireEvent.pointerUp(pinnedRow, { button: 0 });
    expect(rendered.inspection.rpcCalls.filter((call) => call.method === "reorderPinned")).toEqual([]);
  });

  it("renders durable custom state and routes row navigation through host actions", async () => {
    const list = await registration();
    const onNavigate = vi.fn();
    const rendered = renderSlot(list, props({ onNavigate }), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [thread("thread-1", "project-a", 1)] },
      rpc: rpcHandlers({ "thread-1": "review" }, { "thread-1": { model: "gpt-5.6", reasoning: "medium" } }),
    });

    await waitFor(() => expect(rendered.getByText("review")).toBeTruthy());
    expect(rendered.getByText("GPT·M")).toBeTruthy();
    fireEvent.click(rendered.getByText("thread-1"));
    expect(rendered.inspection.sidebarActionCalls).toContainEqual({ method: "open", threadId: "thread-1" });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(rendered.queryByRole("textbox")).toBeNull();
    expect(rendered.queryByText("New thread")).toBeNull();
    expect(rendered.queryByText("Footer")).toBeNull();
  });

  it("reads the native model and reasoning by thread id and falls back safely when unavailable", async () => {
    const host = createFakePluginHost({
      pluginId: "bb-collab",
      sdk: {
        threads: {
          defaultExecutionOptions: async ({ threadId }) => {
            if (threadId === "broken") throw new Error("unavailable");
            if (threadId === "missing") return null;
            return { model: "gpt-5.6", serviceTier: "default", reasoningLevel: "high", permissionMode: "full", source: "client/thread/start" };
          },
        },
      },
    });
    await plugin(host.bb);

    await expect(host.harness.callRpc("threadModels", { threadIds: ["known", "missing", "broken"] })).resolves.toEqual({
      known: { model: "gpt-5.6", reasoning: "high" },
      missing: null,
      broken: null,
    });
    expect(host.harness.inspection.sdk.callsTo("threads.defaultExecutionOptions")).toHaveLength(3);
  });

  it("stores custom state by thread id in plugin KV", async () => {
    const host = createFakePluginHost({ pluginId: "bb-collab" });
    await plugin(host.bb);

    await host.harness.callRpc("setThreadState", { threadId: "thread-1", state: "review" });

    await expect(host.harness.callRpc("threadStates", { threadIds: ["thread-1", "thread-2"] })).resolves.toEqual({ "thread-1": "review" });
    await expect(host.bb.storage.kv.get("sidebar.thread-state:thread-1")).resolves.toBe("review");
  });

  it("persists project/thread collapse in plugin KV and forwards typed reorder to BB", async () => {
    const reorderPinned = vi.fn(async () => ({}) as never);
    const host = createFakePluginHost({ pluginId: "bb-collab", sdk: { threads: { reorderPinned } } });
    await plugin(host.bb);

    await host.harness.callRpc("setSidebarCollapse", { kind: "project", id: "project-a", collapsed: true });
    await host.harness.callRpc("setSidebarCollapse", { kind: "thread", id: "thread-1", collapsed: true });
    await expect(host.harness.callRpc("sidebarCollapseState", { projectIds: ["project-a"], threadIds: ["thread-1"] })).resolves.toEqual({ projects: { "project-a": true }, threads: { "thread-1": true } });

    await host.harness.callRpc("reorderPinned", { threadId: "thread-1", previousThreadId: null, nextThreadId: "thread-2" });
    expect(reorderPinned).toHaveBeenCalledWith({ threadId: "thread-1", previousThreadId: null, nextThreadId: "thread-2" });
  });

  it("accepts the live sidebar population across every batched RPC input", async () => {
    const host = createFakePluginHost({ pluginId: "bb-collab" });
    await plugin(host.bb);
    const { sidebarRpcBatches } = await import("../app");
    const threadIds = Array.from({ length: 829 }, (_, index) => `thread-${index}`);
    const projectIds = Array.from({ length: 829 }, (_, index) => `project-${index}`);
    const threadBatches = sidebarRpcBatches(threadIds);
    const projectBatches = sidebarRpcBatches(projectIds);

    expect(threadBatches.map((batch) => batch.length)).toEqual([256, 256, 256, 61]);
    expect(projectBatches.map((batch) => batch.length)).toEqual([256, 256, 256, 61]);
    await expect(Promise.all(threadBatches.map((batch) => host.harness.callRpc("threadStates", { threadIds: batch })))).resolves.toEqual([{}, {}, {}, {}]);
    await expect(Promise.all(threadBatches.map((batch) => host.harness.callRpc("threadModels", { threadIds: batch })))).resolves.toEqual(threadBatches.map((batch) => Object.fromEntries(batch.map((id) => [id, null]))));
    await expect(Promise.all(projectBatches.map((batch, index) => host.harness.callRpc("sidebarCollapseState", { projectIds: batch, threadIds: threadBatches[index] })))).resolves.toEqual(projectBatches.map(() => ({ projects: {}, threads: {} })));
  });

  it("batches SidebarThreadList RPCs and renders merged responses", async () => {
    const list = await registration();
    const calls = { threadStates: [] as string[][], threadModels: [] as string[][], collapse: [] as Array<{ projectIds: string[]; threadIds: string[] }> };
    const threads = Array.from({ length: 829 }, (_, index) => thread(`thread-${index}`, "project-a", index + 1));
    const rpc = {
      ...(rpcHandlers() as unknown as Record<string, unknown>),
      threadStates: async ({ threadIds }: { threadIds: string[] }) => {
        calls.threadStates.push(threadIds);
        return threadIds.includes("thread-828") ? { "thread-828": "review" } : {};
      },
      threadModels: async ({ threadIds }: { threadIds: string[] }) => {
        calls.threadModels.push(threadIds);
        return threadIds.includes("thread-828") ? { "thread-828": { model: "merged-model", reasoning: "high" } } : {};
      },
      sidebarCollapseState: async ({ projectIds, threadIds }: { projectIds: string[]; threadIds: string[] }) => {
        calls.collapse.push({ projectIds, threadIds });
        return { projects: {}, threads: {} };
      },
    } as never;
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads },
      rpc,
    });

    await waitFor(() => {
      expect(calls.threadStates.length).toBe(4);
      expect(calls.threadModels.length).toBe(4);
      expect(calls.collapse.length).toBe(4);
      expect(calls.threadStates.every((batch) => batch.length <= 256)).toBe(true);
      expect(calls.threadModels.every((batch) => batch.length <= 256)).toBe(true);
      expect(calls.collapse.every(({ projectIds, threadIds }) => projectIds.length <= 256 && threadIds.length <= 256)).toBe(true);
      expect(rendered.getByText("review")).toBeTruthy();
      expect(rendered.getByLabelText("codex · model merged-model · reasoning high")).toBeTruthy();
    });
  });
});
