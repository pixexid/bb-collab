import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../server.js";

const message = {
  messageId: 1,
  projectId: "project-1",
  recipient: "operator",
  senderThreadId: "thread-1",
  senderLaneId: "lane-1",
  severity: "routine",
  text: "Need an answer",
  createdAtMs: 1,
  readAtMs: null,
  archivedAtMs: null,
  senderTitle: "Sender",
  repliedAtMs: null,
  replyText: null,
  replyDeliveryError: null,
  replyInProgress: false,
  notificationStatus: "not-requested",
  notificationError: null,
} as const;

function host(implementation: (request: { method: string; input?: unknown }) => unknown = ({ method }) => (
  method === "v1-inbox-read" ? { outcome: "OK", messages: [message] } : message
)) {
  const callRpc = vi.fn(async (request: { method: string; input?: unknown }) => implementation(request));
  const fixture = createFakePluginHost({
    pluginId: "operator-inbox",
    sdk: { plugins: { callRpc } },
  });
  plugin(fixture.bb);
  return { ...fixture, callRpc };
}

describe("Operator Inbox backend", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("is independently packaged, listed, and built", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const collection = JSON.parse(readFileSync(resolve(root, ".bb/plugins.json"), "utf8"));
    const marketplace = JSON.parse(readFileSync(resolve(root, "marketplace.json"), "utf8"));
    const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"));
    expect(collection.plugins).toContainEqual({ name: "operator-inbox", source: "./plugins/bb-plugin-operator-inbox" });
    expect(marketplace.plugins).toContainEqual(expect.objectContaining({ id: "operator-inbox" }));
    expect(packageJson.bb.branding.icon).toBe("./assets/envelope-simple-duotone.svg");
    expect(existsSync(resolve(import.meta.dirname, "../assets/envelope-simple-duotone.svg"))).toBe(true);
    for (const file of ["app.css", "app.js", "app.meta.json", "server.js", "server.meta.json"]) {
      expect(existsSync(resolve(import.meta.dirname, "../dist", file)), file).toBe(true);
    }
  });

  it("proxies strict versioned read, mark, archive, and reply methods", async () => {
    const fixture = host();

    await expect(fixture.harness.callRpc("operatorMessages", { projectId: "project-1", recipient: "operator" })).resolves.toEqual({ outcome: "OK", messages: [message] });
    await expect(fixture.harness.callRpc("markOperatorMessageRead", { projectId: "project-1", messageId: 1 })).resolves.toEqual(message);
    await expect(fixture.harness.callRpc("archiveOperatorMessage", { projectId: "project-1", messageId: 1 })).resolves.toEqual(message);
    await expect(fixture.harness.callRpc("replyToOperatorMessage", { projectId: "project-1", messageId: 1, text: "answer" })).resolves.toEqual(message);

    expect(fixture.callRpc.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({ pluginId: "bb-collab", method: "v1-inbox-read", input: { projectId: "project-1", recipient: "operator" } }),
      expect.objectContaining({ pluginId: "bb-collab", method: "v1-inbox-mark-read", input: { projectId: "project-1", messageId: 1 } }),
      expect.objectContaining({ pluginId: "bb-collab", method: "v1-inbox-archive", input: { projectId: "project-1", messageId: 1 } }),
      expect.objectContaining({ pluginId: "bb-collab", method: "v1-inbox-reply", input: { projectId: "project-1", messageId: 1, text: "answer" } }),
    ]);
  });

  it("rejects hostile input before core and hostile output at the boundary", async () => {
    const fixture = host(() => ({ ...message, unexpected: true }));

    await expect(fixture.harness.callRpc("archiveOperatorMessage", { projectId: "", messageId: 1 })).rejects.toThrow();
    expect(fixture.callRpc).not.toHaveBeenCalled();
    await expect(fixture.harness.callRpc("archiveOperatorMessage", { projectId: "project-1", messageId: 1 })).rejects.toThrow();
    expect(fixture.callRpc).toHaveBeenCalledTimes(1);
  });

  it("bounds a hung read and keeps one underlying call until its late settlement", async () => {
    vi.useFakeTimers();
    let resolveCore!: (value: unknown) => void;
    const core = new Promise((resolve) => { resolveCore = resolve; });
    const fixture = host(() => core);
    const first = fixture.harness.callRpc("operatorMessages", { projectId: "project-1" }).then(() => null, String);
    const second = fixture.harness.callRpc("operatorMessages", { projectId: "project-1" }).then(() => null, String);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.callRpc).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(await first).toContain("timed out after 4000ms");
    expect(await second).toContain("timed out after 4000ms");
    const retry = fixture.harness.callRpc("operatorMessages", { projectId: "project-1" }).then(() => null, String);
    const otherProject = fixture.harness.callRpc("operatorMessages", { projectId: "project-2" }).then(() => null, String);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await retry).toContain("timed out after 4000ms");
    expect(await otherProject).toContain("timed out after 4000ms");
    expect(fixture.callRpc).toHaveBeenCalledTimes(2);

    resolveCore({ outcome: "OK", messages: [message] });
    await vi.advanceTimersByTimeAsync(0);
  });

  it("bounds idempotent mark/archive calls without multiplying late mutations", async () => {
    vi.useFakeTimers();
    let rejectCore!: (reason: Error) => void;
    const core = new Promise((_, reject) => { rejectCore = reject; });
    const fixture = host(() => core);
    const first = fixture.harness.callRpc("archiveOperatorMessage", { projectId: "project-1", messageId: 1 }).then(() => null, String);
    const second = fixture.harness.callRpc("archiveOperatorMessage", { projectId: "project-1", messageId: 1 }).then(() => null, String);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await first).toContain("timed out after 4000ms");
    expect(await second).toContain("timed out after 4000ms");
    expect(fixture.callRpc).toHaveBeenCalledTimes(1);

    rejectCore(new Error("late core rejection"));
    await vi.advanceTimersByTimeAsync(0);
  });

  it("keeps one reply call alive past the core delivery window without creating a duplicate", async () => {
    vi.useFakeTimers();
    let resolveCore!: (value: unknown) => void;
    const core = new Promise((resolve) => { resolveCore = resolve; });
    const fixture = host(() => core);
    let settled = false;
    const first = fixture.harness.callRpc("replyToOperatorMessage", { projectId: "project-1", messageId: 1, text: "answer" }).finally(() => { settled = true; });
    const duplicate = fixture.harness.callRpc("replyToOperatorMessage", { projectId: "project-1", messageId: 1, text: "different retry" });
    await vi.advanceTimersByTimeAsync(41_000);
    expect(settled).toBe(false);
    expect(fixture.callRpc).toHaveBeenCalledTimes(1);

    resolveCore({ ...message, readAtMs: 2, repliedAtMs: 3, replyText: "answer" });
    await expect(first).resolves.toEqual({ ...message, readAtMs: 2, repliedAtMs: 3, replyText: "answer" });
    await expect(duplicate).resolves.toEqual({ ...message, readAtMs: 2, repliedAtMs: 3, replyText: "answer" });
  });

  it("bounds hung reply callers while retries rejoin the same late-settling core call", async () => {
    vi.useFakeTimers();
    let rejectCore!: (reason: Error) => void;
    const core = new Promise((_, reject) => { rejectCore = reject; });
    const fixture = host(() => core);
    const first = fixture.harness.callRpc("replyToOperatorMessage", { projectId: "project-1", messageId: 1, text: "answer" }).then(() => null, String);

    await vi.advanceTimersByTimeAsync(50_000);
    expect(await first).toContain("still pending after 50000ms; delivery outcome is not yet known and retry will rejoin the same attempt");
    const retry = fixture.harness.callRpc("replyToOperatorMessage", { projectId: "project-1", messageId: 1, text: "retry" }).then(() => null, String);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(await retry).toContain("still pending after 50000ms; delivery outcome is not yet known and retry will rejoin the same attempt");
    expect(fixture.callRpc).toHaveBeenCalledTimes(1);

    rejectCore(new Error("late core rejection"));
    await vi.advanceTimersByTimeAsync(0);
  });

  it("contains missing core failure to Operator Inbox", async () => {
    const fixture = host(() => { throw new Error("core unavailable"); });
    await expect(fixture.harness.callRpc("operatorMessages", { projectId: "project-1" })).rejects.toThrow("core unavailable");
  });
});
