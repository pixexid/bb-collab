// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
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
  return async (input: A) => ({ outcome: "OK", messages: await handler(input) });
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
    expect(rendered.getByText("Need an answer")).toBeTruthy();
    expect(rendered.getByText(/Reply delivery failed: environment deleted/)).toBeTruthy();
    expect(rendered.getByRole("heading", { name: "Project A" })).toBeTruthy();
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

    await waitFor(() => expect(rendered.getByText("unread B")).toBeTruthy());
    expect(operatorMessages).toHaveBeenCalledTimes(2);
    const rows = rendered.getAllByRole("listitem");
    expect(rows[0]!.textContent).toContain("unread B");
    expect(rows[0]!.textContent).toContain("Project B");
    expect(rows[1]!.textContent).toContain("read A");
    expect(rows[1]!.textContent).toContain("Project A");
    fireEvent.change(rendered.getByLabelText("Project"), { target: { value: "project-a" } });
    await waitFor(() => expect(rendered.queryByText("unread B")).toBeNull());
    expect(rendered.getByText("read A")).toBeTruthy();
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

    await waitFor(() => expect(rendered.getByText("Visible after deletion")).toBeTruthy());
    expect(operatorMessages).toHaveBeenCalledWith({ projectId: "project-a", recipient: "operator", withSenderTitles: true });
    expect((rendered.getByLabelText("Project") as HTMLSelectElement).value).toBe("");
  });

  it("shows the sender title with lane, secondary id, and exact navigation", async () => {
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

    const sender = await waitFor(() => rendered.getByRole("link", { name: "Open sender session sender-thread" }));
    expect(sender.textContent).toBe("Inbox drill: URGENT to operator");
    expect(rendered.getByText("lane-one · sender-thread")).toBeTruthy();
    fireEvent.click(sender);
    expect(rendered.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "sender-thread" });
  });

  it("falls back to the secondary sender id when its live title is unavailable", async () => {
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

    const sender = await waitFor(() => rendered.getByRole("link", { name: "Open sender session missing-sender-thread" }));
    expect(sender.textContent).toBe("missing-sender-thread");
    fireEvent.click(sender);
    expect(rendered.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "missing-sender-thread" });
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

    await waitFor(() => expect(rendered.getByText("Inbox remains mounted")).toBeTruthy());
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

    await waitFor(() => expect(rendered.getByText("loaded A")).toBeTruthy());
    expect(rendered.getByText(/Unable to read inbox: Project B \(project-b\): Error: project unavailable/)).toBeTruthy();
  });

  it("skips unregistered projects silently while a genuine read failure keeps its scoped error", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const operatorMessages = vi.fn(async ({ projectId }: { projectId: string }) => {
      if (projectId === "project-b") return { outcome: "PROJECT_CONFIG_REQUIRED", message: "operator inbox project is not registered", messages: [] };
      if (projectId === "project-c") throw new Error("project unavailable");
      return { outcome: "OK", messages: [{ messageId: 7, projectId, recipient: "operator" as const, senderThreadId: "a", senderLaneId: null, severity: "routine" as const, text: "loaded A", createdAtMs: 1, readAtMs: null, repliedAtMs: null, replyText: null, replyDeliveryError: null, notificationStatus: "not-requested" as const, notificationError: null }] };
    });
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A"), project("project-b", "Project B"), project("project-c", "Project C")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages } as never,
    });

    await waitFor(() => expect(rendered.getByText("loaded A")).toBeTruthy());
    expect(rendered.getByText(/Unable to read inbox: Project C \(project-c\): Error: project unavailable/)).toBeTruthy();
    expect(rendered.queryByText(/Unable to read inbox: Project B/)).toBeNull();
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
    await waitFor(() => expect(aggregate.getByText("No operator messages for this project filter.")).toBeTruthy());
    expect(aggregate.container.querySelectorAll("p.text-destructive")).toHaveLength(0);

    fireEvent.change(aggregate.getByLabelText("Project"), { target: { value: "project-b" } });
    await waitFor(() => expect(aggregate.getByText("Unable to read inbox: Project B (project-b): PROJECT_CONFIG_REQUIRED")).toBeTruthy());
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

      await waitFor(() => expect(rendered.getByText("No operator messages for this project filter.")).toBeTruthy());
      expect(rendered.container.querySelectorAll("p.text-destructive")).toHaveLength(0);
      fireEvent.change(rendered.getByLabelText("Project"), { target: { value: "project-b" } });
      await waitFor(() => expect(rendered.getByText("Unable to read inbox: Project B (project-b): PROJECT_CONFIG_REQUIRED")).toBeTruthy());
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

    await waitFor(() => expect(rendered.getByText(/Unable to read inbox: Project B \(project-b\): Error: operator inbox project is not registered/)).toBeTruthy());
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
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: okMessages(async () => [{ messageId: 8, projectId: "proj_a8zzfsx36j", recipient: "operator" as const, senderThreadId: "a", senderLaneId: null, severity: "routine" as const, text: "header check", createdAtMs: 1, readAtMs: null, repliedAtMs: null, replyText: null, replyDeliveryError: null, notificationStatus: "not-requested" as const, notificationError: null }]) } as never,
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

    await waitFor(() => expect(rendered.getByText("answer me")).toBeTruthy());
    fireEvent.click(rendered.getByRole("button", { name: "Mark read" }));
    await waitFor(() => expect(rendered.getByRole("status").textContent).toBe("Marked read."));

    fireEvent.change(rendered.getByLabelText("Reply"), { target: { value: "on it" } });
    fireEvent.click(rendered.getByRole("button", { name: /reply/i }));
    await waitFor(() => expect(rendered.getByRole("status").textContent).toBe("Reply delivered."));
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

    await waitFor(() => expect(rendered.getByText("answer me")).toBeTruthy());
    fireEvent.change(rendered.getByLabelText("Reply"), { target: { value: "on it" } });
    fireEvent.click(rendered.getByRole("button", { name: /reply/i }));
    await waitFor(() => expect(rendered.getByRole("status").textContent).toBe("Reply delivery is still in progress; outcome is not yet known."));
    expect(rendered.queryByText("Reply delivered.")).toBeNull();

    fireEvent.click(rendered.getByRole("button", { name: /reply/i }));
    await waitFor(() => expect(rendered.getByRole("status").textContent).toBe("Reply delivery failed."));
    expect(rendered.getByText("Reply delivery failed: environment deleted")).toBeTruthy();
    expect(rendered.queryByText("Reply delivered.")).toBeNull();

    fireEvent.click(rendered.getByRole("button", { name: /reply/i }));
    await waitFor(() => expect(rendered.getByRole("status").textContent).toBe("Reply delivery is not confirmed."));
    expect(rendered.queryByText("Reply delivered.")).toBeNull();
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

    await waitFor(() => expect(rendered.getByText("archive me")).toBeTruthy());
    fireEvent.click(rendered.getByRole("button", { name: "Archive" }));
    await waitFor(() => expect(archiveOperatorMessage).toHaveBeenCalledWith({ projectId: "project-a", messageId: 10 }));
    expect(rendered.getByRole("status").textContent).toBe("Archived.");
    expect(rendered.queryByText("archive me")).toBeNull();
  });

  it("discloses and caps the aggregate display spill", async () => {
    const app = await loadedApp();
    const inbox = app.navPanels.find((panel) => panel.id === "inbox")!;
    const messages = Array.from({ length: 257 }, (_, index) => ({ messageId: index + 1, projectId: "project-a", recipient: "operator" as const, senderThreadId: "sender", senderLaneId: null, severity: "routine" as const, text: `message ${index + 1}`, createdAtMs: 257 - index, readAtMs: 1, repliedAtMs: null, replyText: null, replyDeliveryError: null, notificationStatus: "not-requested" as const, notificationError: null }));
    const rendered = renderSlot(inbox, { subPath: "" }, {
      sidebarThreads: { status: "ready", projects: [project("project-a", "Project A")], threads: [] },
      rpc: { ...(rpcHandlers() as unknown as Record<string, unknown>), operatorMessages: okMessages(async () => messages) } as never,
    });

    await waitFor(() => expect(rendered.getByText("message 1")).toBeTruthy());
    expect(rendered.getAllByRole("listitem")).toHaveLength(256);
    expect(rendered.getByText("Showing the first 256 of 257 messages; unread messages are first. Select a project to narrow the list.")).toBeTruthy();
    expect(rendered.queryByText("message 257")).toBeNull();
  });

  it("expands compact operator messages in place", async () => {
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
    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(second.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(second);
    expect(first.getAttribute("aria-expanded")).toBe("false");
    expect(second.getAttribute("aria-expanded")).toBe("true");
    expect(rendered.getByText("Reply delivery is still in progress; outcome is not yet known.")).toBeTruthy();
    expect(rendered.queryByText("Supervisor")).toBeNull();
  });

});
