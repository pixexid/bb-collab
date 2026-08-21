// @vitest-environment jsdom

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarProject, PluginSidebarThread, PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { afterEach, describe, expect, it, vi } from "vitest";

// The operator correction: one native-width left slot switches between a
// colored spinner, an accent unread dot, and a grey read dot.

function props(overrides: Partial<PluginThreadListProps> = {}): PluginThreadListProps {
  // bb-app 0.39.0 made experimental_Original required: the host's own thread
  // list, which a plugin may render to defer to default behaviour.
  return {
    activeThreadId: null,
    activeProjectId: null,
    isCompactViewport: false,
    onNavigate: vi.fn(),
    searchQuery: "",
    experimental_Original: () => null,
    ...overrides,
  };
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

    const idle = rendered.container.querySelector('[data-sidebar-thread-id="idle"]')!;
    expect(idle.previousElementSibling?.getAttribute("data-sidebar-thread-signal")).toBe("idle");
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

  it("places every state cue in one native-width leading slot", async () => {
    list = await registration();
    const rendered = render([{ ...thread("unread"), isUnread: true }]);
    const slot = rendered.container.querySelector("[data-sidebar-thread-signal]")! as HTMLElement;
    const dot = slot.querySelector("[data-sidebar-thread-dot]")! as HTMLElement;
    expect(slot.className).toContain("inline-flex");
    expect(slot.className).toContain("h-4");
    expect(slot.className).toContain("w-4");
    expect(slot.className).toContain("max-md:pointer-coarse:h-5");
    expect(slot.className).toContain("max-md:pointer-coarse:w-5");
    expect(dot.className).toContain("size-[5px]");
    expect(dot.className).toContain("bg-primary");
    const anchor = rendered.container.querySelector('[data-sidebar-thread-id="unread"]')!;
    expect(anchor.previousElementSibling).toBe(slot);

    cleanup();
    const read = render([thread("read")]);
    const readDot = read.container.querySelector("[data-sidebar-thread-dot]")! as HTMLElement;
    expect(readDot.className).toContain("bg-muted-foreground/60");
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
    // Every row has the same leading slot; only its glyph/colour changes.
    for (const id of ["failed", "idle"]) {
      const anchor = rendered.container.querySelector(`[data-sidebar-thread-id="${id}"]`)!;
      expect(anchor.previousElementSibling?.getAttribute("data-sidebar-thread-signal"), id).toBeTruthy();
    }

    // Belt and braces: the rail classes must not survive anywhere in source.
    const source = readFileSync(resolve("app.tsx"), "utf8");
    expect(source).not.toMatch(/border-l-2|border-l-primary|border-l-destructive|border-l-transparent/u);
    expect(source).not.toContain("indicatorClasses");
  });

  it("vendors the exact official BB marks for codex, claude-code and pi", async () => {
    const { providerMark } = await import("../src/provider-marks");

    // Geometry copied verbatim from bb-app@0.37.0's plugin-sdk-hooks chunk.
    // These assertions are fingerprints: if a refresh redraws or re-fits a
    // path, they fail rather than silently shipping an approximation.
    const codex = providerMark("codex")!;
    expect(codex.title).toBe("OpenAI");
    expect(codex.viewBox).toBe("0 0 24 24");
    expect(codex.fillRule).toBe("evenodd");
    expect(codex.paths).toHaveLength(1);
    expect(codex.paths[0]).toHaveLength(1461);
    expect(codex.paths[0].startsWith("M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108")).toBe(true);

    const claude = providerMark("claude-code")!;
    expect(claude.title).toBe("Claude");
    expect(claude.viewBox).toBe("0 0 149 149");
    expect(claude.paths).toHaveLength(1);
    expect(claude.paths[0]).toHaveLength(1903);
    expect(claude.paths[0].startsWith("M29.05 98.54L58.19 82.19L58.68 80.77")).toBe(true);
    expect(claude.paths[0].endsWith("L29.04 98.5L29.05 98.54Z")).toBe(true);

    const pi = providerMark("pi")!;
    expect(pi.title).toBe("Pi");
    expect(pi.viewBox).toBe("100 100 600 600");
    expect(pi.fillRule).toBe("evenodd");
    // Luna's review named this one specifically: two paths, not one.
    expect(pi.paths).toHaveLength(2);
    expect(pi.paths[1]).toBe("M517.36 400 H634.72 V634.72 H517.36 Z");

    // Three distinct official marks, not one shape reused.
    expect(new Set([codex.paths[0], claude.paths[0], pi.paths[0]]).size).toBe(3);
  });

  it("matches the marks byte-for-byte against the installed host bundle", async () => {
    const chunk = "/Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/app/dist/assets/plugin-sdk-hooks-CPZOXpqm.js";
    if (!existsSync(chunk)) return; // Host not installed on this machine; the fingerprints above still guard.
    const source = readFileSync(chunk, "utf8");
    const { providerMark } = await import("../src/provider-marks");
    for (const id of ["codex", "claude-code", "pi"]) {
      for (const path of providerMark(id)!.paths) {
        expect(source.includes(path), `${id} path drifted from the host bundle`).toBe(true);
      }
    }
  });

  it("maps vendor aliases and refuses to invent a mark for anything else", async () => {
    const { providerMark } = await import("../src/provider-marks");
    expect(providerMark("openai")).toBe(providerMark("codex"));
    expect(providerMark("anthropic")).toBe(providerMark("claude-code"));
    expect(providerMark("kimi")).toBe(providerMark("pi"));
    // No mark shipped by BB means no glyph — never a substitute shape.
    for (const unknown of ["some-new-provider", "acp-cursor", "", undefined, { nope: true }]) {
      expect(providerMark(unknown), String(unknown)).toBeNull();
    }
  });

  it("renders those marks inline as monochrome currentColor with no network", async () => {
    list = await registration();
    const rendered = render([thread("a", "codex"), thread("b", "claude-code"), thread("c", "pi")]);

    const marks = Array.from(rendered.container.querySelectorAll("svg[data-provider-mark]"));
    expect(marks.map((m) => m.getAttribute("data-provider-mark"))).toEqual(["codex", "claudecode", "pi"]);
    expect(marks.map((m) => m.getAttribute("viewBox"))).toEqual(["0 0 24 24", "0 0 149 149", "100 100 600 600"]);
    for (const mark of marks) {
      expect(mark.getAttribute("fill")).toBe("currentColor");
      expect(mark.getAttribute("aria-hidden")).toBe("true");
      // Monochrome and offline: no hard-coded colour, no fetch of any kind.
      expect(mark.outerHTML).not.toMatch(/https?:|url\(|#[0-9a-f]{3,6}\b|rgb\(/iu);
      expect(mark.outerHTML).not.toMatch(/<image|href=/u);
    }
    expect(rendered.container.querySelector("img, image, use")).toBeNull();
  });
});
