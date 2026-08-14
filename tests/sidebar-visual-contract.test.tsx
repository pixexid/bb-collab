// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@bb/plugin-sdk/testing/app";
import type { PluginSidebarProject, PluginSidebarThread, PluginThreadListProps } from "@bb/plugin-sdk/app";
import { afterEach, describe, expect, it, vi } from "vitest";

// The operator correction: a distinct colored running spinner, a small
// unread/attention dot at the native slot and geometry, no left accent rail at
// all, and real currentColor marks for the provider ids the fleet actually
// reports.

function props(overrides: Partial<PluginThreadListProps> = {}): PluginThreadListProps {
  return { activeThreadId: null, activeProjectId: null, isCompactViewport: false, onNavigate: vi.fn(), searchQuery: "", ...overrides };
}

function thread(id: string, providerId = "codex"): PluginSidebarThread {
  return {
    id,
    projectId: "project-a",
    title: id,
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId,
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

const PROJECT: PluginSidebarProject = { id: "project-a", name: "Project A", isPersonal: false };

function rpcHandlers() {
  return {
    lanes: async () => [],
    threadStates: async () => ({}),
    threadModels: async () => ({}),
    sidebarCollapseState: async () => ({ projects: {}, threads: {} }),
    setSidebarCollapse: async (input: unknown) => input,
    reorderPinned: async () => ({ ok: true }),
    setThreadState: async () => ({ state: null }),
    doctor: async () => ({}) as never,
    export: async () => ({}) as never,
    apply: async () => ({}) as never,
    operatorReceipt: async () => ({}) as never,
  } as never;
}

async function registration() {
  installTestPluginRuntime();
  const app = await loadPluginApp(() => import("../app"));
  return app.threadLists[0]!;
}

function render(threads: PluginSidebarThread[]) {
  return renderSlot(list!, props(), { sidebarThreads: { status: "ready", projects: [PROJECT], threads }, rpc: rpcHandlers() });
}

let list: Awaited<ReturnType<typeof registration>> | undefined;

describe("sidebar visual contract", () => {
  afterEach(() => cleanup());

  it("gives a working row a colored, reduced-motion-safe spinner", async () => {
    list = await registration();
    const rendered = render([{ ...thread("working"), indicator: "workflow", indicatorLabel: "Thread is working" }]);

    const spinner = rendered.container.querySelector("[data-sidebar-thread-spinner]")! as SVGElement;
    expect(spinner).toBeTruthy();
    const cls = spinner.getAttribute("class")!;
    expect(cls).toContain("animate-spin");
    // Colored, not the muted grey the native list uses — this list is denser.
    expect(cls).toContain("text-primary");
    // Reduced motion must stop the spin without hiding the glyph or its name.
    expect(cls).toContain("motion-reduce:animate-none");
    expect(spinner.getAttribute("aria-label")).toBe("Thread is working");
    expect(spinner.getAttribute("stroke")).toBe("currentColor");
  });

  it("puts the spinner to the left of the session name", async () => {
    list = await registration();
    const rendered = render([
      { ...thread("working"), indicator: "workflow", indicatorLabel: "Thread is working" },
      thread("idle"),
    ]);

    const anchor = rendered.container.querySelector('[data-sidebar-thread-id="working"]')!;
    const slot = anchor.previousElementSibling as HTMLElement | null;
    expect(slot).toBeTruthy();
    expect(slot!.getAttribute("data-sidebar-thread-signal")).toBe("running");
    expect(slot!.querySelector("[data-sidebar-thread-spinner]")).toBeTruthy();
    // It leads the title group rather than floating somewhere else in the row.
    expect(anchor.parentElement!.firstElementChild).toBe(slot);

    // An idle row reserves no space for it.
    const idle = rendered.container.querySelector('[data-sidebar-thread-id="idle"]')!;
    expect(idle.previousElementSibling).toBeNull();
  });

  it("keeps the spinner and the dot distinct and mutually exclusive", async () => {
    list = await registration();
    const rendered = render([
      { ...thread("working"), indicator: "workflow", indicatorLabel: "Thread is working" },
      { ...thread("unread"), indicator: "unread-success", indicatorLabel: "Unread" },
    ]);

    expect(rendered.container.querySelectorAll("[data-sidebar-thread-spinner]").length).toBe(1);
    expect(rendered.container.querySelectorAll("[data-sidebar-thread-dot]").length).toBe(1);
    for (const slot of Array.from(rendered.container.querySelectorAll("[data-sidebar-thread-signal]"))) {
      const glyphs = slot.querySelectorAll("[data-sidebar-thread-spinner],[data-sidebar-thread-dot]");
      expect(glyphs.length).toBe(1);
    }
  });

  it("places the dot in the native trailing slot at native geometry", async () => {
    list = await registration();
    const rendered = render([{ ...thread("unread"), indicator: "unread-success", indicatorLabel: "Unread" }]);

    const slot = rendered.container.querySelector("[data-sidebar-thread-signal]")! as HTMLElement;
    const dot = slot.querySelector("[data-sidebar-thread-dot]")! as HTMLElement;
    // Native measurements, read off the built-in list in the running app.
    expect(slot.className).toContain("size-4");
    expect(dot.className).toContain("size-[5px]");
    expect(dot.className).toContain("rounded-full");
    expect(dot.className).not.toMatch(/size-1\.5(?!\s|$)/u);

    // After the title, and NOT inside the meta cluster that holds the badge.
    const anchor = rendered.container.querySelector('[data-sidebar-thread-id="unread"]')!;
    expect(anchor.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const badge = rendered.container.querySelector("[data-thread-execution-badge]");
    expect(badge && slot.contains(badge)).toBeFalsy();
    expect(badge?.parentElement?.contains(slot)).toBeFalsy();
  });

  it("draws no left accent rail, ornament, or spacer on any row", async () => {
    list = await registration();
    const rendered = render([
      { ...thread("working"), indicator: "workflow", indicatorLabel: "Thread is working" },
      { ...thread("failed"), indicator: "unread-error", indicatorLabel: "Thread failed" },
      thread("idle"),
    ]);

    for (const anchor of Array.from(rendered.container.querySelectorAll("[data-sidebar-thread-id]"))) {
      const row = anchor.closest("div")!;
      expect(row.className).not.toMatch(/border-l/u);
    }
    // Only the working row leads with anything, and that thing is the spinner —
    // never a rail, a bullet, or a blank box holding space.
    for (const id of ["failed", "idle"]) {
      const anchor = rendered.container.querySelector(`[data-sidebar-thread-id="${id}"]`)!;
      expect(anchor.previousElementSibling, id).toBeNull();
      expect(anchor.parentElement!.firstElementChild, id).toBe(anchor);
    }

    // Belt and braces: the rail classes must not survive anywhere in source.
    const source = readFileSync(resolve("app.tsx"), "utf8");
    expect(source).not.toMatch(/border-l-2|border-l-primary|border-l-destructive|border-l-transparent/u);
    expect(source).not.toContain("indicatorClasses");
  });

  it("ships no look-alike provider artwork", async () => {
    list = await registration();
    const rendered = render([thread("a", "codex"), thread("b", "claude-code"), thread("c", "pi")]);

    // BB's official provider logos are host-internal; `@bb/plugin-sdk/app`
    // exports no way to render them. Shipping our own shapes would put
    // unofficial vendor artwork on screen, so the badge is text only.
    expect(rendered.container.querySelector("[data-provider-mark]")).toBeNull();
    for (const badge of Array.from(rendered.container.querySelectorAll("[data-thread-execution-badge]"))) {
      expect(badge.querySelector("svg")).toBeNull();
      expect(badge.outerHTML).not.toMatch(/<image|href=|url\(/u);
    }

    const source = readFileSync(resolve("app.tsx"), "utf8");
    expect(source).not.toContain("PROVIDER_MARKS");
    expect(source).not.toContain("ProviderMark");
  });

  it("keeps the provider fact in the badge's text and accessible name", async () => {
    list = await registration();
    const { executionBadgeLabel } = await import("../app");
    // Provider identity is still reported, from the host's own value.
    for (const id of ["codex", "claude-code", "pi"]) {
      expect(executionBadgeLabel(id, { model: "gpt-5.6-luna", reasoning: "high" })).toContain(id);
    }
  });
});
