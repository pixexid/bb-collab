// @vitest-environment jsdom

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
    setThreadState: async (input: { threadId: string; state: string | null }) => ({ state: input.state }),
    doctor: async () => ({}) as never,
    export: async () => ({}) as never,
    apply: async () => ({}) as never,
    operatorReceipt: async () => ({}) as never,
  } as never;
}

describe("replacement thread list", () => {
  afterEach(() => cleanup());

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
});
