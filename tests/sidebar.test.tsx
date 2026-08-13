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

function rpcHandlers(states: Record<string, string> = {}, models: Record<string, string | null> = {}) {
  return {
    lanes: async () => [],
    threadStates: async () => states,
    threadModels: async () => models,
    sidebarCollapseState: async () => ({ projects: {}, threads: {} }),
    setSidebarCollapse: async (input: { kind: "project" | "thread"; id: string; collapsed: boolean }) => input,
    reorderPinned: async () => ({ ok: true }),
    setThreadState: async (input: { threadId: string; state: string | null }) => ({ state: input.state }),
    doctor: async () => ({}) as never,
    export: async () => ({}) as never,
    apply: async () => ({}) as never,
    operatorReceipt: async () => ({}) as never,
  } as never;
}

describe("replacement thread list", () => {
  afterEach(() => cleanup());

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

  it("renders resolved running, attention, idle, and pending signals", async () => {
    const { threadSignal } = await import("../app");
    expect(threadSignal({ ...thread("running", "p", 1), activity: { workflows: 1, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 }, indicatorLabel: "Thread is working" })).toEqual({ kind: "running", label: "Thread is working", glyph: "◌" });
    expect(threadSignal({ ...thread("attention", "p", 1), indicator: "unread-error", indicatorLabel: "Thread failed" }).kind).toBe("attention");
    expect(threadSignal(thread("idle", "p", 1)).kind).toBe("idle");
    expect(threadSignal({ ...thread("pending", "p", 1), hasPendingInteraction: true }).kind).toBe("pending");
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

  it("sends typed pinned reorder args from a real row drag/drop", async () => {
    const list = await registration();
    const first = { ...thread("pinned-1", "project-a", 2), isPinned: true };
    const second = { ...thread("pinned-2", "project-a", 1), isPinned: true };
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [first, second] },
      rpc: rpcHandlers(),
    });
    const transfer = { setData: vi.fn(), getData: () => "pinned-1", setDragImage: vi.fn(), effectAllowed: "none" };
    fireEvent.dragStart(rendered.container.querySelector('[data-sidebar-thread-id="pinned-1"]')!, { dataTransfer: transfer });
    fireEvent.drop(rendered.container.querySelector('[data-sidebar-thread-id="pinned-2"]')!, { dataTransfer: transfer });
    await waitFor(() => expect(rendered.inspection.rpcCalls).toContainEqual({
      method: "reorderPinned",
      input: { threadId: "pinned-1", previousThreadId: null, nextThreadId: "pinned-2" },
    }));
  });

  it("keeps the pointer drag fallback on the same typed reorder path", async () => {
    const list = await registration();
    const first = { ...thread("pinned-1", "project-a", 2), isPinned: true };
    const second = { ...thread("pinned-2", "project-a", 1), isPinned: true };
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [first, second] },
      rpc: rpcHandlers(),
    });
    const firstRow = rendered.container.querySelector('[data-sidebar-thread-id="pinned-1"]')!;
    const secondRow = rendered.container.querySelector('[data-sidebar-thread-id="pinned-2"]')!;
    fireEvent.pointerDown(firstRow, { button: 0 });
    fireEvent.pointerUp(secondRow, { button: 0 });
    await waitFor(() => expect(rendered.inspection.rpcCalls).toContainEqual({
      method: "reorderPinned",
      input: { threadId: "pinned-1", previousThreadId: null, nextThreadId: "pinned-2" },
    }));
  });

  it("keeps the mouse drag fallback on the same typed reorder path", async () => {
    const list = await registration();
    const first = { ...thread("pinned-1", "project-a", 2), isPinned: true };
    const second = { ...thread("pinned-2", "project-a", 1), isPinned: true };
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [first, second] },
      rpc: rpcHandlers(),
    });
    const firstRow = rendered.container.querySelector('[data-sidebar-thread-id="pinned-1"]')!;
    const secondRow = rendered.container.querySelector('[data-sidebar-thread-id="pinned-2"]')!;
    fireEvent.mouseDown(firstRow, { button: 0 });
    fireEvent.mouseUp(secondRow, { button: 0 });
    await waitFor(() => expect(rendered.inspection.rpcCalls).toContainEqual({
      method: "reorderPinned",
      input: { threadId: "pinned-1", previousThreadId: null, nextThreadId: "pinned-2" },
    }));
  });

  it("commits native dragend after dragenter when drop is unavailable", async () => {
    const list = await registration();
    const first = { ...thread("pinned-1", "project-a", 2), isPinned: true };
    const second = { ...thread("pinned-2", "project-a", 1), isPinned: true };
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [first, second] },
      rpc: rpcHandlers(),
    });
    const firstRow = rendered.container.querySelector('[data-sidebar-thread-id="pinned-1"]')!;
    const secondRow = rendered.container.querySelector('[data-sidebar-thread-id="pinned-2"]')!;
    const transfer = { setData: vi.fn(), getData: () => "pinned-1", setDragImage: vi.fn(), effectAllowed: "none" };
    fireEvent.dragStart(firstRow, { dataTransfer: transfer });
    fireEvent.dragEnter(secondRow);
    fireEvent.dragEnd(firstRow);
    await waitFor(() => expect(rendered.inspection.rpcCalls).toContainEqual({
      method: "reorderPinned",
      input: { threadId: "pinned-1", previousThreadId: null, nextThreadId: "pinned-2" },
    }));
  });

  it("renders durable custom state and routes row navigation through host actions", async () => {
    const list = await registration();
    const onNavigate = vi.fn();
    const rendered = renderSlot(list, props({ onNavigate }), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [thread("thread-1", "project-a", 1)] },
      rpc: rpcHandlers({ "thread-1": "review" }, { "thread-1": "gpt-5.6" }),
    });

    await waitFor(() => expect(rendered.getByText("review")).toBeTruthy());
    expect(rendered.getByText("codex/gpt-5.6")).toBeTruthy();
    fireEvent.click(rendered.getByText("thread-1"));
    expect(rendered.inspection.sidebarActionCalls).toContainEqual({ method: "open", threadId: "thread-1" });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(rendered.queryByRole("textbox")).toBeNull();
    expect(rendered.queryByText("New thread")).toBeNull();
    expect(rendered.queryByText("Footer")).toBeNull();
  });

  it("reads the native model by thread id and falls back safely when unavailable", async () => {
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
      known: "gpt-5.6",
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
});
