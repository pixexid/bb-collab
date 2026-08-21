// @vitest-environment jsdom

import { cleanup, waitFor } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";
import type { PluginSidebarProject, PluginSidebarThread, PluginThreadListProps } from "@bb/plugin-sdk/app";
import { afterEach, describe, expect, it, vi } from "vitest";

// The live crash (React #31) came from artifact skew, not from bad host data: a
// frontend bundle built when `threadModels` returned `string | null` rendered a
// newer server's `{ model, reasoning }` object as a React child. Types cannot
// catch that — the two artifacts are compiled separately — so these cases feed
// the component shapes its types rule out and assert it still renders.

function props(overrides: Partial<PluginThreadListProps> = {}): PluginThreadListProps {
  // bb-app 0.39.0 made experimental_Original required: the host's own thread
  // list, which a plugin may render to defer to default behaviour.
  return { activeThreadId: null, activeProjectId: null, isCompactViewport: false, onNavigate: vi.fn(), searchQuery: "", experimental_Original: () => null, ...overrides };
}

function baseThread(id: string, projectId: string): PluginSidebarThread {
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
    createdAt: 1,
    updatedAt: 2,
    lastReadAt: 2,
    latestAttentionAt: 2,
  };
}

// Deliberately untyped: every override here is a shape the DTO forbids.
function hostile(id: string, projectId: string, overrides: Record<string, unknown>): PluginSidebarThread {
  return { ...baseThread(id, projectId), ...overrides } as PluginSidebarThread;
}

function rpcHandlers(states: Record<string, unknown>, models: Record<string, unknown>) {
  return {
    lanes: async () => [],
    threadStates: async () => states,
    threadModels: async () => models,
    sidebarCollapseState: async () => ({ projects: {}, threads: {} }),
    setSidebarCollapse: async (input: unknown) => input,
    reorderPinned: async () => ({ ok: true }),
    setThreadState: async () => ({ state: null }),
    doctor: async () => ({}) as never,
    export: async () => ({}) as never,
    apply: async () => ({}) as never,
  } as never;
}

async function registration() {
  installTestPluginRuntime();
  const app = await loadPluginApp(() => import("../app"));
  return app.threadLists[0]!;
}

describe("hostile runtime shapes", () => {
  afterEach(() => cleanup());

  it("renders when a stale-bundle server returns a nested execution object", async () => {
    const list = await registration();
    const threads = [baseThread("thread-1", "project-a")];
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [{ id: "project-a", name: "Project A", isPersonal: false }], threads },
      // The exact live payload the old bundle choked on.
      rpc: rpcHandlers({}, { "thread-1": { model: { model: "gpt-5.6-luna", reasoning: "max" }, reasoning: { model: "x", reasoning: "y" } } }),
    });

    await waitFor(() => expect(rendered.getByText("thread-1")).toBeTruthy());
    const badge = rendered.container.querySelector("[data-thread-execution-badge]");
    expect(badge).toBeTruthy();
    // Neutral fallback, never a stringified object and never a fabricated model.
    expect(badge!.textContent).toBe("—·–");
    expect(badge!.getAttribute("aria-label")).toBe("codex · model unavailable · reasoning unavailable");
  });

  it("renders rows whose optional identity, provider, and activity fields are absent", async () => {
    const list = await registration();
    const threads = [
      hostile("thread-untitled", "project-a", { title: null, titleFallback: null }),
      hostile("thread-noprovider", "project-a", { providerId: undefined }),
      hostile("thread-noactivity", "project-a", { activity: undefined, indicator: undefined, indicatorLabel: undefined }),
      hostile("thread-badtitle", "project-a", { title: { nope: true }, titleFallback: null }),
      // Points at a parent that is not in the set: must stay a visible root, not vanish.
      hostile("thread-orphan", "project-a", { parentThreadId: "missing-parent", environment: undefined, host: undefined }),
    ];
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [{ id: "project-a", name: undefined } as unknown as PluginSidebarProject], threads },
      rpc: rpcHandlers({ "thread-untitled": { not: "a string" } }, { "thread-noprovider": null }),
    });

    await waitFor(() => expect(rendered.container.querySelectorAll("[data-sidebar-thread-id]").length).toBe(threads.length));
    expect(rendered.getAllByText("Untitled thread").length).toBe(2);
    // A missing project name falls back to the stable id, never to blank chrome.
    expect(rendered.getByText("project-a")).toBeTruthy();
    // A non-string custom state is dropped rather than rendered.
    expect(rendered.container.querySelector("[data-custom-thread-state]")).toBeNull();
  });

  it("survives searching and grouping over the same hostile rows", async () => {
    const list = await registration();
    const threads = [
      hostile("thread-noprovider", "project-a", { providerId: undefined, environment: { branchName: undefined } }),
      hostile("thread-badproject", "project-missing", { providerId: null }),
    ];
    const rendered = renderSlot(list, props({ searchQuery: "thread" }), {
      sidebarThreads: { status: "ready", projects: [{ id: "project-a", name: "Project A", isPersonal: false }], threads },
      rpc: rpcHandlers({}, {}),
    });

    await waitFor(() => expect(rendered.container.querySelectorAll("[data-sidebar-thread-id]").length).toBe(2));
  });
});
