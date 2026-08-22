// @vitest-environment jsdom

import { cleanup } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, mountPluginContentScripts, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";

const lane = {
  projectId: "project-1",
  laneId: "lane-1",
  assignmentId: null,
  assignmentKind: "write" as const,
  workItemId: "work-1",
  threadId: "thread-1",
  executionAttemptId: "attempt-1",
  attemptState: "in_progress",
  workerStatus: "active" as const,
  waitingOn: null,
  ageMs: 1_000,
  tone: "running" as const,
  queueState: "running" as const,
  queueBlocked: false,
  nextStartable: false,
  deferredReason: null,
  deferredAtMs: null,
  deferredAgeMs: null,
};

async function loadedApp() {
  installTestPluginRuntime();
  return loadPluginApp(() => import("../app"));
}

describe("Collaboration Lanes app", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("owns exactly the Lanes panel and lane pulse registrations", async () => {
    const app = await loadedApp();
    expect(app.navPanels.map(({ id }) => id)).toEqual(["lanes"]);
    expect(app.contentScripts.map(({ id }) => id)).toEqual(["lane-thread-status"]);
  });

  it("renders the extracted panel without changing its lane presentation", async () => {
    const app = await loadedApp();
    const rendered = renderSlot(app.navPanels[0]!, {} as never, {
      rpc: { lanes: async () => [lane] },
    });

    expect(await rendered.findByText("lane-1")).toBeTruthy();
    expect(rendered.getByText("thread-1")).toBeTruthy();
    expect(rendered.getByText("worker")).toBeTruthy();
  });

  it("preserves the last pulse across failure, clears absent lanes, and cleans up", async () => {
    vi.useFakeTimers();
    const responses = [
      new Response(JSON.stringify([lane]), { status: 200 }),
      new Response("unavailable", { status: 503 }),
      new Response(JSON.stringify([]), { status: 200 }),
      new Response(JSON.stringify([lane]), { status: 200 }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));
    const mounted = await mountPluginContentScripts(await loadedApp(), { pluginId: "collaboration-lanes" });
    await vi.waitFor(() => expect(mounted.inspection.getThreadRowStatus("thread-1")?.label).toBe("Lane lane-1: open"));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mounted.inspection.getThreadRowStatus("thread-1")?.label).toBe("Lane lane-1: open");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mounted.inspection.getThreadRowStatus("thread-1")).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mounted.inspection.getThreadRowStatus("thread-1")?.label).toBe("Lane lane-1: open");

    await mounted.lifecycle.dispose();
    expect(mounted.inspection.getThreadRowStatus("thread-1")).toBeNull();
  });

  it("remains compatible with hosts that omit the optional pulse API", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const mounted = await mountPluginContentScripts(await loadedApp(), {
      pluginId: "collaboration-lanes",
      omitExperimentalThreadRowStatus: true,
    });
    expect(mounted.inspection.mountedIds).toEqual(["lane-thread-status"]);
    expect(fetch).not.toHaveBeenCalled();
    await mounted.lifecycle.dispose();
  });
});
