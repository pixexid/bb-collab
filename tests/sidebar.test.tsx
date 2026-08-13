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
    const dotOf = (kind: string) => rendered.container.querySelector(`[data-sidebar-thread-signal="${kind}"]`)! as HTMLElement;

    expect(dotOf("running").className).toContain("bg-primary");
    expect(dotOf("pending").className).toContain("bg-primary");
    expect(dotOf("attention").className).toContain("bg-destructive");
    expect(dotOf("idle").className).toContain("bg-muted-foreground/40");
    // Colour is the only feedback dimension: identical geometry, no motion, and
    // nothing nested beside it.
    for (const kind of ["running", "pending", "attention", "idle"]) {
      expect(dotOf(kind).className).toContain("size-1.5");
      expect(dotOf(kind).className).not.toMatch(/animate-|size-2|size-3|border-2/u);
      expect(dotOf(kind).childElementCount).toBe(0);
    }
    expect(dotOf("running").getAttribute("aria-label")).toBe("Thread is working");
    // The indicator label is its own state, not part of the row link's name.
    expect(rendered.getByRole("link", { name: "running" })).toBeTruthy();
  });

  it("puts no ornament or spacer in front of the row title", async () => {
    const list = await registration();
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [
        { ...thread("running", "project-a", 1), indicator: "workflow", indicatorLabel: "Thread is working" },
      ] },
      rpc: rpcHandlers(),
    });
    const anchor = rendered.container.querySelector<HTMLAnchorElement>('[data-sidebar-thread-id="running"]')!;
    // The title leads the row: no icon, no dot and no placeholder box holding
    // the space one used to occupy.
    expect(anchor.previousElementSibling).toBeNull();
    expect(anchor.parentElement!.firstElementChild).toBe(anchor);
    // The state dot lives after the title, at the native right edge.
    const dot = rendered.container.querySelector('[data-sidebar-thread-signal]')!;
    expect(anchor.compareDocumentPosition(dot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it("renders the execution badge as a bundled monochrome mark plus short text", async () => {
    const list = await registration();
    const rendered = renderSlot(list, props(), {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [thread("thread-1", "project-a", 1)] },
      rpc: rpcHandlers({}, { "thread-1": { model: "gpt-5.6-luna", reasoning: "high" } }),
    });

    const badge = await waitFor(() => rendered.getByRole("img", { name: "codex · model gpt-5.6-luna · reasoning high" }));
    expect(badge.textContent).toBe("Luna·H");
    // No long provider/model text survives in the row.
    expect(rendered.queryByText("codex/gpt-5.6-luna")).toBeNull();

    const mark = badge.querySelector("svg")!;
    expect(mark.getAttribute("data-provider-mark")).toBe("codex");
    expect(mark.getAttribute("stroke")).toBe("currentColor");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    // Theme token only: nothing hard-codes a colour or reaches off-device.
    expect(mark.outerHTML).not.toMatch(/https?:|url\(|#[0-9a-f]{3,6}\b|rgb\(/iu);
    expect(rendered.container.querySelector("img, image, use")).toBeNull();
  });

  it("falls back to a generic mark for a provider it ships no mark for", async () => {
    const list = await registration();
    const rendered = renderSlot(list, props(), {
      sidebarThreads: {
        status: "ready",
        projects: [project("project-a", "Project A")],
        threads: [{ ...thread("thread-1", "project-a", 1), providerId: "claude-code" }, { ...thread("thread-2", "project-a", 2), providerId: "some-new-provider" }],
      },
      rpc: rpcHandlers(),
    });

    const marks = Array.from(rendered.container.querySelectorAll("svg[data-provider-mark]"));
    expect(marks.map((mark) => mark.getAttribute("data-provider-mark"))).toEqual(["somenewprovider", "claudecode"]);
    expect(marks.every((mark) => mark.querySelector("path")!.getAttribute("d"))).toBeTruthy();
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
});
