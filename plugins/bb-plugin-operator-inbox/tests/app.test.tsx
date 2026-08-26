// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarProject } from "@get-bb/plugin-sdk/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../server.js";

function project(id: string, name: string): PluginSidebarProject {
  return { id, name, isPersonal: false };
}

async function loadedApp() {
  installTestPluginRuntime();
  return loadPluginApp(() => import("../app"));
}

function rpcHandlers() {
  return {
    operatorMessages: async () => ({ outcome: "OK", messages: [] }),
    markOperatorMessageRead: async () => ({}),
    archiveOperatorMessage: async () => ({}),
    replyToOperatorMessage: async () => ({}),
  } as never;
}

// #280: the reader answers { outcome, messages }. Cases that only vary the rows
// keep returning arrays and are wrapped in the OK outcome here; a case about the
// outcome itself returns the result directly.
function okMessages<A>(handler: (input: A) => Promise<unknown[]>) {
  return async (input: A) => ({ outcome: "OK", messages: (await handler(input)).map((message) => ({ archivedAtMs: null, ...(message as object) })) });
}

describe("Operator Inbox app", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("keeps path-install app packaging independent from server imports", async () => {
    const appSource = readFileSync(resolve(import.meta.dirname, "../app.tsx"), "utf8");
    expect(appSource).toMatch(/import\s+type\s+\{\s*rpcContract\s*\}\s+from\s+["']\.\/contract["']/);
    expect(appSource).not.toMatch(/import\s+\{[^}]*rpcContract[^}]*\}\s+from\s+["']\.\/contract["']/);
    await loadedApp();
  });

  it("owns only the Inbox panel", async () => {
    const app = await loadedApp();
    expect(app.navPanels.map((panel) => panel.id)).toEqual(["inbox"]);
    expect(app.contentScripts).toEqual([]);
  });

  it("uses decorative duotone Phosphor actions without Unicode glyph fallbacks", () => {
    const source = readFileSync(resolve(import.meta.dirname, "../app.tsx"), "utf8");
    for (const icon of ["ArchiveIcon", "EnvelopeOpenIcon", "PaperPlaneTiltIcon", "ArrowClockwiseIcon"]) {
      expect(source).toContain(icon);
    }
    expect(source.match(/weight="duotone"/g)?.length).toBeGreaterThanOrEqual(4);
    expect(source.match(/color="currentColor"/g)?.length).toBeGreaterThanOrEqual(4);
    expect(source.match(/aria-hidden="true"/g)?.length).toBeGreaterThanOrEqual(4);
    expect(source).not.toMatch(/[>](?:↻|↗|✓|▱)[<]/);
  });

  it("renders message and delivered-reply bodies as safe Markdown (no image fetch, hard line breaks)", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const operatorMessages = vi.fn(async () => [{
      messageId: 7,
      projectId: "project-a",
      recipient: "operator" as const,
      senderThreadId: "sender-thread",
      senderLaneId: null,
      severity: "routine" as const,
      text: "**Blocked** on [issue](https://example.invalid/1)\nand a beacon ![pixel](https://example.invalid/pixel?m=7)\n\n- one",
      createdAtMs: 1,
      readAtMs: 2,
      senderTitle: "Director",
      repliedAtMs: 3,
      replyText: "line one\nline two",
      replyDeliveryError: null,
      notificationStatus: "not-requested" as const,
      notificationError: null,
    }]);
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: okMessages(operatorMessages) } as never,
    });
    await waitFor(() => expect(operatorMessages).toHaveBeenCalled());
    await waitFor(() => expect(rendered.container.querySelector("strong")?.textContent).toBe("Blocked"));
    const link = rendered.container.querySelector("a[href='https://example.invalid/1']");
    expect(link).not.toBeNull();
    // P1: a markdown image in a fleet-authored body must never emit <img> (no read beacon);
    // its alt text is shown instead.
    expect(rendered.container.querySelector("img")).toBeNull();
    expect(rendered.getByText("pixel")).toBeTruthy();
    // P2: a single newline inside the body and the reply stays a hard line break.
    expect(rendered.container.querySelectorAll("br").length).toBeGreaterThanOrEqual(2);
    expect(rendered.container.textContent).toContain("line one");
    expect(rendered.container.textContent).toContain("line two");
    expect(rendered.getByText("one").tagName).toBe("LI");
    // Spacing/markers survive host preflight: paragraphs carry margin, lists carry markers + indent.
    expect(rendered.getByText("one").closest("ul")?.className).toContain("list-disc");
    expect(rendered.container.querySelectorAll("p.my-1\\.5").length).toBeGreaterThan(0);
    const source = readFileSync(resolve(import.meta.dirname, "../app.tsx"), "utf8");
    expect(source).not.toContain("whitespace-pre-wrap break-words text-sm leading-6");
  });

  it("renders fleet-authored HTML and hostile URL schemes inert", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const operatorMessages = vi.fn(async () => [{
      messageId: 8,
      projectId: "project-a",
      recipient: "operator" as const,
      senderThreadId: "s",
      senderLaneId: null,
      severity: "routine" as const,
      text: "<script>alert(1)</script><img src=\"https://example.invalid/x\" onerror=\"alert(2)\"> [bad](javascript:alert(3))",
      createdAtMs: 1,
      readAtMs: null,
      senderTitle: null,
      repliedAtMs: null,
      replyText: null,
      replyDeliveryError: null,
      notificationStatus: "not-requested" as const,
      notificationError: null,
    }]);
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: okMessages(operatorMessages) } as never,
    });
    await waitFor(() => expect(operatorMessages).toHaveBeenCalled());
    await waitFor(() => expect(rendered.container.textContent).toContain("<script>alert(1)</script>"));
    expect(rendered.container.querySelector("script")).toBeNull();
    expect(rendered.container.querySelectorAll("img").length).toBe(0);
    expect(rendered.container.querySelector("a[href^='javascript']")).toBeNull();
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
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: okMessages(operatorMessages) } as never,
    });

    await waitFor(() => expect(operatorMessages).toHaveBeenCalledWith({ projectId: "project-a", recipient: "operator", withSenderTitles: true }));
    fireEvent.change(rendered.getByLabelText("Project"), { target: { value: "project-a" } });
    await waitFor(() => expect(operatorMessages).toHaveBeenCalledWith({ projectId: "project-a", recipient: "operator", withSenderTitles: true }));
    expect(rendered.getAllByText("Need an answer").length).toBeGreaterThan(0);
    expect(rendered.getByText(/Delivery failed: environment deleted/)).toBeTruthy();
    expect(rendered.getAllByText("Sender unavailable")).toHaveLength(2);
    expect(rendered.getAllByText("Project A").length).toBeGreaterThan(0);
  });

  it("refreshes with archived messages after Show archived is checked", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const operatorMessages = vi.fn(async () => []);
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: okMessages(operatorMessages) } as never,
    });

    await waitFor(() => expect(operatorMessages).toHaveBeenCalledWith({ projectId: "project-a", recipient: "operator", withSenderTitles: true }));
    fireEvent.click(rendered.getByLabelText("Show archived"));
    await waitFor(() => expect(operatorMessages).toHaveBeenLastCalledWith({ projectId: "project-a", recipient: "operator", withSenderTitles: true, includeArchived: true }));
  });

  it("keeps same-minute relative times minimal while exact labels include seconds and offset", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const now = Date.now();
    const messages = [
      { messageId: 20, projectId: "project-a", recipient: "operator" as const, senderThreadId: "sender-a", senderLaneId: null, severity: "routine" as const, text: "First timestamp", createdAtMs: now - 10 * 60 * 1000 - 5 * 1000, readAtMs: null, archivedAtMs: null, repliedAtMs: null, replyText: null, replyDeliveryError: null, replyInProgress: false, notificationStatus: "not-requested" as const, notificationError: null },
      { messageId: 21, projectId: "project-a", recipient: "operator" as const, senderThreadId: "sender-b", senderLaneId: null, severity: "routine" as const, text: "Second timestamp", createdAtMs: now - 10 * 60 * 1000 - 45 * 1000, readAtMs: null, archivedAtMs: null, repliedAtMs: null, replyText: null, replyDeliveryError: null, replyInProgress: false, notificationStatus: "not-requested" as const, notificationError: null },
    ];
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: okMessages(async () => messages) } as never,
    });

    await waitFor(() => expect(rendered.getAllByText("First timestamp").length).toBeGreaterThan(0));
    const times = Array.from(rendered.container.querySelectorAll("time"));
    const exactLabels = [...new Set(times.map((time) => time.getAttribute("title")).filter((label): label is string => label !== null))];
    expect(exactLabels).toHaveLength(2);
    expect(exactLabels.every((label) => /\d{1,2}:\d{2}:\d{2}/.test(label))).toBe(true);
    expect(exactLabels.every((label) => /GMT|UTC|[A-Z]{2,5}/.test(label))).toBe(true);
    expect(times.every((time) => time.textContent === "10m ago")).toBe(true);
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
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: okMessages(operatorMessages) } as never,
    });

    await waitFor(() => expect(rendered.getAllByText("unread B").length).toBeGreaterThan(0));
    expect(operatorMessages).toHaveBeenCalledTimes(2);
    const rows = rendered.getAllByRole("listitem");
    expect(rendered.getAllByText("unread B").length).toBeGreaterThan(0);
    expect(rows[0]!.textContent).toContain("Project B");
    expect(rendered.getAllByText("read A").length).toBeGreaterThan(0);
    expect(rows[1]!.textContent).toContain("Project A");
    fireEvent.change(rendered.getByLabelText("Project"), { target: { value: "project-a" } });
    await waitFor(() => expect(rendered.queryByText("unread B")).toBeNull());
    expect(rendered.getAllByText("read A").length).toBeGreaterThan(0);
  });

  it("persists project and archived filters without exposing supervisor controls", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const options = {
      sidebarThreads: { status: "ready" as const, projects: [project("project-a", "Project A")], threads: [] },
      rpc: rpcHandlers(),
    };
    const first = renderSlot(inbox, { subPath: "" }, options);
    fireEvent.change(first.getByLabelText("Project"), { target: { value: "project-a" } });
    fireEvent.click(first.getByLabelText("Show archived"));
    expect(first.queryByLabelText("Recipient")).toBeNull();
    first.lifecycle.unmount();

    const reopened = renderSlot(inbox, { subPath: "" }, options);
    expect((reopened.getByLabelText("Project") as HTMLSelectElement).value).toBe("project-a");
    expect((reopened.getByLabelText("Show archived") as HTMLInputElement).checked).toBe(true);
    expect(reopened.queryByLabelText("Recipient")).toBeNull();
  });

  it("fails the panel read closed when an operator-filtered response contains a non-operator row", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const operator = { messageId: 1, projectId: "project-a", recipient: "operator" as const, senderThreadId: "operator-sender", senderLaneId: null, severity: "routine" as const, text: "operator row must also stay closed", createdAtMs: 2, readAtMs: null, repliedAtMs: null, replyText: null, replyDeliveryError: null, notificationStatus: "not-requested" as const, notificationError: null };
    const supervisor = { ...operator, messageId: 2, recipient: "supervisor" as const, senderThreadId: "supervisor-sender", text: "hostile supervisor row" };
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: okMessages(async () => [operator, supervisor]) } as never,
    });

    await waitFor(() => expect(rendered.getByText(/Refresh failed: Project A \(project-a\): Error: operator inbox response included a non-operator message/)).toBeTruthy());
    expect(rendered.queryByText("operator row must also stay closed")).toBeNull();
    expect(rendered.queryByText("hostile supervisor row")).toBeNull();
  });

  it("fails the panel read closed when an operator row belongs to another project", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: okMessages(async () => [{ messageId: 2, projectId: "project-b", recipient: "operator" as const, senderThreadId: "foreign", senderLaneId: null, severity: "routine" as const, text: "foreign row must stay hidden", createdAtMs: 2, readAtMs: null, senderTitle: null, repliedAtMs: null, replyText: null, replyDeliveryError: null, notificationStatus: "not-requested" as const, notificationError: null }]) } as never,
    });

    await waitFor(() => expect(rendered.getByText(/Refresh failed: Project A \(project-a\): Error: operator inbox response included a foreign-project message/)).toBeTruthy());
    expect(rendered.queryByText("foreign row must stay hidden")).toBeNull();
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
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: okMessages(operatorMessages) } as never,
    });

    await waitFor(() => expect(rendered.getAllByText("Visible after deletion").length).toBeGreaterThan(0));
    expect(operatorMessages).toHaveBeenCalledWith({ projectId: "project-a", recipient: "operator", withSenderTitles: true });
    expect((rendered.getByLabelText("Project") as HTMLSelectElement).value).toBe("");
  });

  it("shows the compact linked sender title with exact navigation without raw ids", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: okMessages(async () => [{
        messageId: 4,
        projectId: "project-a",
        recipient: "operator" as const,
        senderThreadId: "sender-thread",
        senderTitle: "Inbox drill: URGENT to operator",
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
      }]) } as never,
    });

    const sender = await waitFor(() => rendered.getByRole("link", { name: "Open sender session Inbox drill: URGENT to operator" }));
    expect(sender.textContent).toBe("Inbox drill: URGENT to operator");
    expect(rendered.queryByText("lane-one")).toBeNull();
    expect(rendered.queryByText("sender-thread")).toBeNull();
    fireEvent.click(sender);
    expect(rendered.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "sender-thread" });
  });

  it("does not expose a raw sender id when its live title is unavailable", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: okMessages(async () => [{
        messageId: 5,
        projectId: "project-a",
        recipient: "operator" as const,
        senderThreadId: "missing-sender-thread",
        senderTitle: null,
        senderLaneId: null,
        severity: "routine" as const,
        text: "Fallback sender",
        createdAtMs: 1,
        readAtMs: null,
        repliedAtMs: null,
        replyText: null,
        replyDeliveryError: null,
        notificationStatus: "not-requested" as const,
        notificationError: null,
      }]) } as never,
    });

    await waitFor(() => expect(rendered.getAllByText("Sender unavailable")).toHaveLength(2));
    expect(rendered.queryByText("missing-sender-thread")).toBeNull();
  });

  it("keeps the inbox mounted when a sender id has a hostile shape", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: okMessages(async () => [{
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
      } as never]) } as never,
    });

    await waitFor(() => expect(rendered.getAllByText("Inbox remains mounted").length).toBeGreaterThan(0));
    expect(rendered.queryByRole("link")).toBeNull();
    expect(rendered.getAllByText("Sender unavailable")).toHaveLength(2);
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
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: okMessages(operatorMessages) } as never,
    });

    await waitFor(() => expect(rendered.getAllByText("loaded A").length).toBeGreaterThan(0));
    expect(rendered.getByText(/Refresh failed: Project B \(project-b\): Error: project unavailable/)).toBeTruthy();
  });

  it("skips unregistered projects silently while a genuine read failure keeps its scoped error", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const operatorMessages = vi.fn(async ({ projectId }: { projectId: string }) => {
      if (projectId === "project-b") return { outcome: "PROJECT_CONFIG_REQUIRED", message: "operator inbox project is not registered", messages: [] };
      if (projectId === "project-c") throw new Error("project unavailable");
      return { outcome: "OK", messages: [{ messageId: 7, projectId, recipient: "operator" as const, senderThreadId: "a", senderLaneId: null, severity: "routine" as const, text: "loaded A", createdAtMs: 1, readAtMs: null, archivedAtMs: null, repliedAtMs: null, replyText: null, replyDeliveryError: null, notificationStatus: "not-requested" as const, notificationError: null }] };
    });
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A"), project("project-b", "Project B"), project("project-c", "Project C")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages } as never,
    });

    await waitFor(() => expect(rendered.getAllByText("loaded A").length).toBeGreaterThan(0));
    expect(rendered.getByText(/Refresh failed: Project C \(project-c\): Error: project unavailable/)).toBeTruthy();
    expect(rendered.queryByText(/Refresh failed: Project B/)).toBeNull();
    expect(rendered.container.querySelectorAll("p.text-destructive")).toHaveLength(1);
  });

  it("binds the skip to the outcome code the server itself produces, and only in aggregate mode", async () => {
    const host = createFakePluginHost({
      pluginId: "operator-inbox",
      sdk: { plugins: { callRpc: async () => ({ outcome: "PROJECT_CONFIG_REQUIRED", message: "operator inbox project is not registered", messages: [] }) } },
    });
    await plugin(host.bb);
    // The result is taken from the running server rather than authored here, so
    // a server that stopped answering PROJECT_CONFIG_REQUIRED for this
    // condition breaks the test rather than the operator's screen.
    const serverResult = await host.harness.callRpc("operatorMessages", { projectId: "project-b" }) as { outcome: string; message?: string };
    expect(serverResult.outcome).toBe("PROJECT_CONFIG_REQUIRED");

    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const options = {
      sidebarThreads: { status: "ready" as const, projects: [project("project-b", "Project B")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: async () => serverResult } as never,
    };

    const aggregate = renderSlot(inbox, { subPath: "" }, options);
    await waitFor(() => expect(aggregate.getByText("No messages in this view")).toBeTruthy());
    expect(aggregate.container.querySelectorAll("p.text-destructive")).toHaveLength(0);

    fireEvent.change(aggregate.getByLabelText("Project"), { target: { value: "project-b" } });
    await waitFor(() => expect(aggregate.getByText("Refresh failed: Project B (project-b): PROJECT_CONFIG_REQUIRED")).toBeTruthy());
  });

  it("branches on the outcome code alone, so rewording the human sentence moves nothing", async () => {
    // #280's whole point, read in scoped mode because that is where skipping and
    // loading-zero-rows look different: the code must produce the refusal row
    // for every sentence, including the one the panel used to match on, a
    // localised one, and none at all.
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;

    for (const message of ["operator inbox project is not registered", "le projet n'a pas de boîte de réception", undefined]) {
      const rendered = renderSlot(inbox, { subPath: "" }, {
        sidebarThreads: { status: "ready" as const, projects: [project("project-b", "Project B")], threads: [] },
        rpc: {
          ...(rpcHandlers() as unknown as Record<string, unknown>),
          operatorMessages: async () => ({ outcome: "PROJECT_CONFIG_REQUIRED", ...(message === undefined ? {} : { message }), messages: [] }),
        } as never,
      });

      await waitFor(() => expect(rendered.getByText("No messages in this view")).toBeTruthy());
      expect(rendered.container.querySelectorAll("p.text-destructive")).toHaveLength(0);
      fireEvent.change(rendered.getByLabelText("Project"), { target: { value: "project-b" } });
      await waitFor(() => expect(rendered.getByText("Refresh failed: Project B (project-b): PROJECT_CONFIG_REQUIRED")).toBeTruthy());
      cleanup();
      window.localStorage.clear();
    }
  });

  it("treats a rejection carrying the old sentence as the failed read it is", async () => {
    // The inverse direction: the exact sentence the panel used to branch on now
    // buys nothing, because a rejection is a failed read whatever it says.
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-b", "Project B")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: async () => { throw new Error("operator inbox project is not registered"); } } as never,
    });

    await waitFor(() => expect(rendered.getByText(/Refresh failed: Project B \(project-b\): Error: operator inbox project is not registered/)).toBeTruthy());
  });

  it("keeps a failure that merely quotes the unregistered sentence visible", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-b", "Project B")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: async () => { throw new Error("transport failed after operator inbox project is not registered response"); } } as never,
    });

    await waitFor(() => expect(rendered.getByText(/Refresh failed: Project B \(project-b\): Error: transport failed after operator inbox project is not registered response/)).toBeTruthy());
  });

  it("headers the card with the project name and not its raw id", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("proj_a8zzfsx36j", "bb-collab")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: okMessages(async () => [{ messageId: 8, projectId: "proj_a8zzfsx36j", recipient: "operator" as const, senderThreadId: "a", senderLaneId: null, severity: "routine" as const, text: "header check", createdAtMs: 1, readAtMs: null, repliedAtMs: null, replyText: null, replyDeliveryError: null, notificationStatus: "not-requested" as const, notificationError: null }]) } as never,
    });

    await waitFor(() => expect(rendered.getAllByText("header check").length).toBeGreaterThan(0));
    const card = rendered.container.querySelector("article")!;
    expect(card.textContent).toContain("bb-collab");
    expect(card.textContent).not.toContain("proj_a8zzfsx36j");
    expect(rendered.getAllByText("All projects").length).toBeGreaterThan(0);
  });

  it("confirms a delivered reply and a mark-read with visible success feedback", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const message = { messageId: 9, projectId: "project-a", recipient: "operator" as const, senderThreadId: "a", senderLaneId: null, severity: "routine" as const, text: "answer me", createdAtMs: 1, readAtMs: null, archivedAtMs: null, senderTitle: null, repliedAtMs: null, replyText: null, replyDeliveryError: null, replyInProgress: false, notificationStatus: "not-requested" as const, notificationError: null };
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: {
        ...(rpcHandlers() as unknown as Record<string, unknown>),
        operatorMessages: okMessages(async () => [message]),
        markOperatorMessageRead: async () => ({ ...message, readAtMs: 5 }),
        replyToOperatorMessage: async () => ({ ...message, readAtMs: 5, repliedAtMs: 6, replyText: "on it" }),
      } as never,
    });

    await waitFor(() => expect(rendered.getAllByText("answer me").length).toBeGreaterThan(0));
    fireEvent.click(rendered.getByRole("button", { name: "Mark message read" }));
    await waitFor(() => expect(rendered.getByRole("status").textContent).toBe("Marked read. This message is no longer counted as unread."));

    fireEvent.change(rendered.getByLabelText("Reply text"), { target: { value: "on it" } });
    fireEvent.click(rendered.getByRole("button", { name: /reply/i }));
    await waitFor(() => expect(rendered.getByRole("status").textContent).toBe("Reply delivered. BB confirmed the matching input."));
    const archive = rendered.getAllByRole("button", { name: "Archive message" }).at(-1)!;
    expect(archive.hasAttribute("disabled")).toBe(false);
    expect(archive.textContent).not.toContain("Archive");
  });

  it("keeps mark-read and archive pending, single-flight, and recoverable", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const message = { messageId: 22, projectId: "project-a", recipient: "operator" as const, senderThreadId: "a", senderLaneId: null, severity: "routine" as const, text: "pending controls", createdAtMs: 1, readAtMs: null as number | null, archivedAtMs: null, repliedAtMs: null, replyText: null, replyDeliveryError: null, replyInProgress: false, notificationStatus: "not-requested" as const, notificationError: null };
    let resolveRead!: (value: typeof message) => void;
    let rejectArchive!: (reason: unknown) => void;
    const readResult = new Promise<typeof message>((resolve) => { resolveRead = resolve; });
    const archiveResult = new Promise<typeof message>((_resolve, reject) => { rejectArchive = reject; });
    const markOperatorMessageRead = vi.fn(async () => readResult);
    const archiveOperatorMessage = vi.fn(async () => archiveResult);
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: okMessages(async () => [message]), markOperatorMessageRead, archiveOperatorMessage } as never,
    });

    await waitFor(() => expect(rendered.getAllByText("pending controls").length).toBeGreaterThan(0));
    const markRead = rendered.getByRole("button", { name: "Mark message read" });
    fireEvent.click(markRead);
    fireEvent.click(markRead);
    expect(markOperatorMessageRead).toHaveBeenCalledTimes(1);
    expect(markRead.hasAttribute("disabled")).toBe(true);
    expect(markRead.getAttribute("aria-busy")).toBe("true");
    expect(rendered.getByRole("button", { name: "Marking message read" })).toBeTruthy();

    await act(async () => resolveRead({ ...message, readAtMs: 5 }));
    await waitFor(() => expect(rendered.queryByRole("button", { name: "Mark message read" })).toBeNull());
    const archiveButtons = rendered.getAllByRole("button", { name: "Archive message" });
    const rowArchive = archiveButtons[0]!;
    const detailArchive = archiveButtons.at(-1)!;
    fireEvent.click(rowArchive);
    fireEvent.click(detailArchive);
    expect(archiveOperatorMessage).toHaveBeenCalledTimes(1);
    expect(rowArchive.hasAttribute("disabled")).toBe(true);
    expect(detailArchive.hasAttribute("disabled")).toBe(true);
    expect(rowArchive.getAttribute("aria-busy")).toBe("true");
    expect(detailArchive.getAttribute("aria-busy")).toBe("true");
    expect(rendered.getAllByRole("button", { name: "Archiving message" })).toHaveLength(2);

    await act(async () => rejectArchive(new Error("archive unavailable")));
    await waitFor(() => expect(rendered.getAllByRole("button", { name: "Archive message" }).at(-1)).toBeTruthy());
    expect(rendered.getAllByRole("button", { name: "Archive message" }).at(-1)!.hasAttribute("disabled")).toBe(false);
    expect(rendered.getByText("Refresh failed: Error: archive unavailable")).toBeTruthy();
  });

  it("offers compact archive actions on unread and delivered rows without nesting controls", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const messages = [
      { messageId: 31, projectId: "project-a", recipient: "operator" as const, senderThreadId: "a", senderLaneId: null, severity: "routine" as const, text: "unread row", createdAtMs: 2, readAtMs: null, archivedAtMs: null, senderTitle: null, repliedAtMs: null, replyText: null, replyDeliveryError: null, replyInProgress: false, notificationStatus: "not-requested" as const, notificationError: null },
      { messageId: 32, projectId: "project-a", recipient: "operator" as const, senderThreadId: "b", senderLaneId: null, severity: "routine" as const, text: "delivered row", createdAtMs: 1, readAtMs: 1, archivedAtMs: null, senderTitle: null, repliedAtMs: 3, replyText: "done", replyDeliveryError: null, replyInProgress: false, notificationStatus: "not-requested" as const, notificationError: null },
    ];
    const archiveOperatorMessage = vi.fn(async () => ({ ...messages[1]!, archivedAtMs: 5 }));
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: okMessages(async () => messages), archiveOperatorMessage } as never,
    });

    await waitFor(() => expect(rendered.getAllByText("unread row").length).toBeGreaterThan(0));
    const rows = rendered.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const selectedUnread = rows[0]!.querySelector('button[aria-pressed="true"]')!;
    expect(selectedUnread.getAttribute("aria-label")).toContain("Selected.");
    expect(selectedUnread.getAttribute("aria-label")).toContain("Unread.");
    expect(rows[0]!.className).toContain("bg-primary/5");
    expect(rows[0]!.className).toContain("ring-primary");
    expect(rows[0]!.querySelector(".h-2.w-2.rounded-full")).toBeNull();
    expect(rows.every((row) => row.querySelector('button[aria-label="Archive message"]') !== null)).toBe(true);
    expect(rows.every((row) => row.querySelector("button button, button a, a button") === null)).toBe(true);
    expect(rendered.getAllByRole("button", { name: "Archive message" })).toHaveLength(3);

    fireEvent.click(rows[1]!.querySelector('button[aria-label="Archive message"]')!);
    await waitFor(() => expect(archiveOperatorMessage).toHaveBeenCalledWith({ projectId: "project-a", messageId: 32 }));
    await waitFor(() => expect(rendered.queryByText("delivered row")).toBeNull());
    expect(rendered.getAllByText("unread row").length).toBeGreaterThan(0);
  });

  it("does not claim delivery for pending or explicitly failed reply results", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const message = { messageId: 10, projectId: "project-a", recipient: "operator" as const, senderThreadId: "a", senderLaneId: null, severity: "routine" as const, text: "answer me", createdAtMs: 1, readAtMs: null, archivedAtMs: null, senderTitle: null, repliedAtMs: null, replyText: null, replyDeliveryError: null, replyInProgress: false, notificationStatus: "not-requested" as const, notificationError: null };
    const replyToOperatorMessage = vi.fn()
      .mockResolvedValueOnce({ ...message, replyInProgress: true })
      .mockResolvedValueOnce({ ...message, readAtMs: 5, replyText: "on it", replyDeliveryError: "environment deleted" })
      .mockResolvedValueOnce({ ...message, readAtMs: 5, replyText: "on it" });
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: {
        ...(rpcHandlers() as unknown as Record<string, unknown>),
        operatorMessages: okMessages(async () => [message]),
        replyToOperatorMessage,
      } as never,
    });

    await waitFor(() => expect(rendered.getAllByText("answer me").length).toBeGreaterThan(0));
    fireEvent.change(rendered.getByLabelText("Reply text"), { target: { value: "on it" } });
    fireEvent.click(rendered.getByRole("button", { name: /reply/i }));
    await waitFor(() => expect(rendered.getAllByRole("status").map((status) => status.textContent)).toContain("Delivery pending. The outcome is not yet known."));
    expect(rendered.queryByText("Reply delivered")).toBeNull();

    fireEvent.click(rendered.getByRole("button", { name: /reply/i }));
    await waitFor(() => expect(rendered.getByRole("status").textContent).toBe("Delivery failed. The message remains retryable."));
    expect(rendered.getByText("Delivery failed: environment deleted You can retry without losing this message.")).toBeTruthy();
    expect(rendered.queryByText("Reply delivered")).toBeNull();

    fireEvent.click(rendered.getByRole("button", { name: /reply/i }));
    await waitFor(() => expect(rendered.getByRole("status").textContent).toBe("Reply delivery is not confirmed."));
    expect(rendered.queryByText("Reply delivered")).toBeNull();
  });

  it("archives a message with visible success feedback", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const message = { messageId: 10, projectId: "project-a", recipient: "operator" as const, senderThreadId: "a", senderLaneId: null, severity: "routine" as const, text: "archive me", createdAtMs: 1, readAtMs: null, archivedAtMs: null, senderTitle: null, repliedAtMs: null, replyText: null, replyDeliveryError: null, replyInProgress: false, notificationStatus: "not-requested" as const, notificationError: null };
    const archiveOperatorMessage = vi.fn(async () => ({ ...message, archivedAtMs: 5 }));
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: {
        ...(rpcHandlers() as unknown as Record<string, unknown>),
        operatorMessages: okMessages(async () => [message]),
        archiveOperatorMessage,
      } as never,
    });

    await waitFor(() => expect(rendered.getAllByText("archive me").length).toBeGreaterThan(0));
    fireEvent.click(rendered.getAllByRole("button", { name: "Archive message" }).at(-1)!);
    await waitFor(() => expect(archiveOperatorMessage).toHaveBeenCalledWith({ projectId: "project-a", messageId: 10 }));
    expect(rendered.getByRole("status").textContent).toBe("Archived. Turn on Show archived to include it again.");
    expect(rendered.queryByText("archive me")).toBeNull();
  });

  it("keeps a newer archived-filter refresh authoritative when an older archive result settles", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const message = { messageId: 11, projectId: "project-a", recipient: "operator" as const, senderThreadId: "a", senderLaneId: null, senderTitle: "Before archive", severity: "routine" as const, text: "archive race", createdAtMs: 1, readAtMs: null, archivedAtMs: null, repliedAtMs: null, replyText: null, replyDeliveryError: null, replyInProgress: false, notificationStatus: "not-requested" as const, notificationError: null };
    const refreshed = { ...message, senderTitle: "Refreshed archived row", archivedAtMs: 5 };
    let resolveArchive!: (value: typeof refreshed) => void;
    const archiveResult = new Promise<typeof refreshed>((resolve) => { resolveArchive = resolve; });
    const operatorMessages = okMessages(async (input: { includeArchived?: boolean }) => input.includeArchived ? [refreshed] : [message]);
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages, archiveOperatorMessage: async () => archiveResult } as never,
    });

    await waitFor(() => expect(rendered.getAllByText("archive race").length).toBeGreaterThan(0));
    fireEvent.click(rendered.getAllByRole("button", { name: "Archive message" }).at(-1)!);
    fireEvent.click(rendered.getByLabelText("Show archived"));
    await waitFor(() => expect(rendered.getAllByText("Refreshed archived row").length).toBeGreaterThan(0));
    await act(async () => resolveArchive({ ...message, senderTitle: "Late archive result", archivedAtMs: 5 }));

    await waitFor(() => expect(rendered.getByRole("status").textContent).toBe("Archived. Turn on Show archived to include it again."));
    expect(rendered.getAllByText("Refreshed archived row").length).toBeGreaterThan(0);
    expect(rendered.queryByText("Late archive result")).toBeNull();
  });

  it("surfaces a late archive failure without disturbing the newer archived-filter refresh", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const message = { messageId: 12, projectId: "project-a", recipient: "operator" as const, senderThreadId: "a", senderLaneId: null, senderTitle: "Before failed archive", severity: "routine" as const, text: "failed archive race", createdAtMs: 1, readAtMs: null, archivedAtMs: null, repliedAtMs: null, replyText: null, replyDeliveryError: null, replyInProgress: false, notificationStatus: "not-requested" as const, notificationError: null };
    const refreshed = { ...message, senderTitle: "Refresh survived failure", archivedAtMs: 5 };
    let rejectArchive!: (reason: unknown) => void;
    const archiveResult = new Promise<typeof refreshed>((_resolve, reject) => { rejectArchive = reject; });
    const operatorMessages = okMessages(async (input: { includeArchived?: boolean }) => input.includeArchived ? [refreshed] : [message]);
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages, archiveOperatorMessage: async () => archiveResult } as never,
    });

    await waitFor(() => expect(rendered.getAllByText("failed archive race").length).toBeGreaterThan(0));
    fireEvent.click(rendered.getAllByRole("button", { name: "Archive message" }).at(-1)!);
    fireEvent.click(rendered.getByLabelText("Show archived"));
    await waitFor(() => expect(rendered.getAllByText("Refresh survived failure").length).toBeGreaterThan(0));
    await act(async () => rejectArchive(new Error("archive unavailable")));

    await waitFor(() => expect(rendered.getByText("Refresh failed: Error: archive unavailable")).toBeTruthy());
    expect(rendered.getAllByText("Refresh survived failure").length).toBeGreaterThan(0);
  });

  it("discloses and caps the aggregate display spill", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const messages = Array.from({ length: 257 }, (_, index) => ({ messageId: index + 1, projectId: "project-a", recipient: "operator" as const, senderThreadId: "sender", senderLaneId: null, severity: "routine" as const, text: `message ${index + 1}`, createdAtMs: 257 - index, readAtMs: 1, repliedAtMs: null, replyText: null, replyDeliveryError: null, notificationStatus: "not-requested" as const, notificationError: null }));
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: okMessages(async () => messages) } as never,
    });

    await waitFor(() => expect(rendered.getAllByText("message 1").length).toBeGreaterThan(0));
    expect(rendered.getAllByRole("listitem")).toHaveLength(256);
    expect(rendered.getByText("Showing the first 256 of 257 messages. Unread messages appear first.")).toBeTruthy();
    expect(rendered.queryByText("message 257")).toBeNull();
  });

  it("renders durable message numbers in active, replied, and archived rows and detail", async () => {
    window.localStorage.setItem("bb-collab.inbox-filters", JSON.stringify({ projectId: "", showArchived: true }));
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const messages = [
      { messageId: 50, projectId: "project-a", recipient: "operator" as const, senderThreadId: "sender-a", senderLaneId: null, senderTitle: "A sender with a deliberately long title that must not displace its number", severity: "routine" as const, text: "An active message with a long body that remains secondary to the durable number.", createdAtMs: 3, readAtMs: null, archivedAtMs: null, replyText: null, replyDeliveryError: null, replyInProgress: false, notificationStatus: "not-requested" as const, notificationError: null },
      { messageId: 51, projectId: "project-a", recipient: "operator" as const, senderThreadId: "sender-b", senderLaneId: null, senderTitle: "Replied sender", severity: "needs-decision" as const, text: "A replied message", createdAtMs: 2, readAtMs: 4, archivedAtMs: null, repliedAtMs: 5, replyText: "Reply delivered", replyDeliveryError: null, replyInProgress: false, notificationStatus: "not-requested" as const, notificationError: null },
      { messageId: 52, projectId: "project-a", recipient: "operator" as const, senderThreadId: "sender-c", senderLaneId: null, senderTitle: "Archived sender", severity: "routine" as const, text: "An archived message", createdAtMs: 1, readAtMs: 6, archivedAtMs: 7, repliedAtMs: null, replyText: null, replyDeliveryError: null, replyInProgress: false, notificationStatus: "not-requested" as const, notificationError: null },
    ];
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: okMessages(async () => messages) } as never,
    });

    await waitFor(() => expect(rendered.getAllByRole("listitem")).toHaveLength(3));
    const rows = rendered.getAllByRole("listitem");
    for (const [index, messageId] of [50, 51, 52].entries()) {
      expect(rows[index]!.textContent).toContain(`#${messageId}`);
      expect(rows[index]!.querySelector("button")?.getAttribute("aria-label")).toContain(`#${messageId}`);
    }
    expect(rendered.getByRole("heading", { name: "Message #50" })).toBeTruthy();
    fireEvent.click(rows[1]!.querySelector("button")!);
    expect(rendered.getByRole("heading", { name: "Message #51" })).toBeTruthy();
    fireEvent.click(rows[2]!.querySelector("button")!);
    expect(rendered.getByRole("heading", { name: "Message #52" })).toBeTruthy();
  });

  it("keeps the selected message preview and detail pane truthful", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const messages = [
      { messageId: 1, projectId: "project-a", recipient: "operator" as const, senderThreadId: "sender-a", senderLaneId: null, senderTitle: "Sender A", severity: "routine" as const, text: "First message body", createdAtMs: 2, readAtMs: null, archivedAtMs: null, repliedAtMs: null, replyText: null, replyDeliveryError: null, replyInProgress: false, notificationStatus: "not-requested" as const, notificationError: null },
      { messageId: 2, projectId: "project-a", recipient: "operator" as const, senderThreadId: "sender-b", senderLaneId: null, senderTitle: "Sender B", severity: "needs-decision" as const, text: "Second message body", createdAtMs: 1, readAtMs: 3, archivedAtMs: null, repliedAtMs: null, replyText: "waiting", replyDeliveryError: null, replyInProgress: true, notificationStatus: "not-requested" as const, notificationError: null },
    ];
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: okMessages(async () => messages) } as never,
    });

    await waitFor(() => expect(rendered.getAllByRole("listitem")).toHaveLength(2));
    const rows = rendered.getAllByRole("listitem");
    const first = rows[0]!.querySelector("button")!;
    const second = rows[1]!.querySelector("button")!;
    expect(first.getAttribute("aria-pressed")).toBe("true");
    expect(second.getAttribute("aria-pressed")).toBe("false");
    expect(rendered.getAllByText("First message body")).toHaveLength(2);
    fireEvent.click(second);
    expect(first.getAttribute("aria-pressed")).toBe("false");
    expect(second.getAttribute("aria-pressed")).toBe("true");
    expect(rendered.getAllByText("Second message body")).toHaveLength(2);
    expect(rendered.getByText("Delivery pending. Keep this message open; the outcome is not yet known.")).toBeTruthy();
    expect(rendered.queryByText("Supervisor")).toBeNull();
  });

});
