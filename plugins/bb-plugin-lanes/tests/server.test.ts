import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../server.js";

const lane = {
  projectId: "project-1",
  laneId: "lane-1",
  assignmentId: null,
  assignmentKind: "write",
  workItemId: "work-1",
  threadId: "thread-1",
  executionAttemptId: "attempt-1",
  attemptState: "in_progress",
  workerStatus: "active",
  waitingOn: null,
  ageMs: 1_000,
  tone: "running",
  queueState: "running",
  queueBlocked: false,
  nextStartable: false,
  deferredReason: null,
  deferredAtMs: null,
  deferredAgeMs: null,
} as const;

function host(result: unknown = [lane]) {
  const callRpc = vi.fn(async () => result);
  const fixture = createFakePluginHost({
    pluginId: "collaboration-lanes",
    sdk: { plugins: { callRpc } },
  });
  plugin(fixture.bb);
  return { ...fixture, callRpc };
}

describe("Collaboration Lanes backend", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("is independently packaged, listed, and built", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const collection = JSON.parse(readFileSync(resolve(root, ".bb/plugins.json"), "utf8"));
    const marketplace = JSON.parse(readFileSync(resolve(root, "marketplace.json"), "utf8"));
    expect(collection.plugins).toContainEqual({ name: "collaboration-lanes", source: "./plugins/bb-plugin-lanes" });
    expect(marketplace.plugins).toContainEqual(expect.objectContaining({ id: "collaboration-lanes" }));
    for (const file of ["app.css", "app.js", "app.meta.json", "server.js", "server.meta.json"]) {
      expect(existsSync(resolve(import.meta.dirname, "../dist", file)), file).toBe(true);
    }
  });

  it("proxies its RPC and HTTP reads through the strict versioned core method", async () => {
    const fixture = host();

    await expect(fixture.harness.callRpc("lanes", {})).resolves.toEqual([lane]);
    expect(fixture.callRpc).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: "bb-collab",
      method: "v1-lanes",
      input: {},
    }));
    const response = await fixture.harness.fetchHttp("GET", "/lanes");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([lane]);
  });

  it("rejects invalid core output instead of weakening the boundary", async () => {
    const fixture = host([{ ...lane, assignmentId: undefined, unexpected: true }]);

    await expect(fixture.harness.callRpc("lanes", {})).rejects.toThrow();
    expect((await fixture.harness.fetchHttp("GET", "/lanes")).status).toBe(503);
  });

  it("loads independently and contains core unavailability to this plugin", async () => {
    const fixture = host();
    expect(fixture.callRpc).not.toHaveBeenCalled();
    fixture.harness.sdk.stub("plugins.callRpc", async () => { throw new Error("core unavailable"); });

    await expect(fixture.harness.callRpc("lanes", {})).rejects.toThrow("core unavailable");
    expect((await fixture.harness.fetchHttp("GET", "/lanes")).status).toBe(503);
  });

  it("bounds a never-settling core read across RPC and HTTP pollers", async () => {
    vi.useFakeTimers();
    let rejectCore!: (reason: Error) => void;
    const fixture = host(new Promise((_, reject) => { rejectCore = reject; }));
    const rpc = fixture.harness.callRpc("lanes", {}).then(() => null, (error: unknown) => error);
    const http = fixture.harness.fetchHttp("GET", "/lanes");
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.callRpc).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(String(await rpc)).toContain("timed out after 4000ms");
    expect((await http).status).toBe(503);

    const next = fixture.harness.callRpc("lanes", {}).then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(String(await next)).toContain("timed out after 4000ms");
    expect(fixture.callRpc).toHaveBeenCalledTimes(1);

    rejectCore(new Error("late core rejection"));
    await vi.advanceTimersByTimeAsync(0);
  });
});
