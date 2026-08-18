import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost, makeThreadResponse } from "@bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import plugin from "../server.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function project(projectId: string) {
  return { id: projectId, name: "Brief project", sources: [{ id: "source-main" }] };
}

describe("role briefs", () => {
  it("composes canonical docs with live project pointers", async () => {
    const host = createFakePluginHost({ pluginId: "bb-collab" });
    host.harness.sdk.stub("projects.get", (async ({ projectId }: { projectId: string }) => project(projectId)) as never);
    await plugin(host.bb);

    await expect(host.harness.callRpc("roleBrief", { projectId: "project-brief", role: "worker" })).resolves.toMatchObject({
      role: "worker",
      project: { id: "project-brief", name: "Brief project", sourceIds: ["source-main"] },
      pointers: { canonicalStoreQuery: "role_generation_heads joined to role_generations", currentSeats: [] },
      ponytail: expect.stringContaining("Does this need to exist at all?"),
      roleContent: expect.stringContaining("# Worker"),
      prompt: expect.stringContaining("## Ponytail preamble"),
    });
  });

  it("waits for a created worker to become idle before sending its role brief", async () => {
    const host = createFakePluginHost({ pluginId: "bb-collab" });
    host.harness.sdk.stub("projects.get", (async ({ projectId }: { projectId: string }) => project(projectId)) as never);
    let releaseIdle!: () => void;
    const idle = new Promise<void>((resolve) => { releaseIdle = resolve; });
    host.harness.sdk.stub("threads.wait", (async ({ status }: { status: string }) => {
      if (status === "idle") await idle;
      return { matched: true };
    }) as never);
    host.harness.sdk.stub("threads.send", (async () => ({ ok: true })) as never);
    await plugin(host.bb);

    const delivery = host.harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "worker-brief", projectId: "project-brief", status: "active" }) });
    await vi.waitFor(() => expect(host.harness.inspection.sdk.callsTo("threads.wait")).toHaveLength(1));
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    releaseIdle();
    await expect(delivery).resolves.toEqual({ errors: [] });
    const request = host.harness.inspection.sdk.callsTo("threads.send")[0]?.[0] as { threadId: string; mode: string; input: Array<{ visibility: string; text: string }> };
    expect(request).toMatchObject({ threadId: "worker-brief", mode: "queue-if-active" });
    expect(request.input[0]).toMatchObject({ visibility: "agent-only", text: expect.stringContaining("Does this need to exist at all?") });
    expect(host.harness.inspection.sdk.callsTo("threads.wait")[0]?.[0]).toMatchObject({ threadId: "worker-brief", status: "idle", timeoutMs: 30_000 });
  });

  it("serializes concurrent role briefs for the same thread across idle wait and send", async () => {
    const host = createFakePluginHost({ pluginId: "bb-collab" });
    host.harness.sdk.stub("projects.get", (async ({ projectId }: { projectId: string }) => project(projectId)) as never);
    let status: "idle" | "active" = "idle";
    let releaseIdle!: () => void;
    const idle = new Promise<void>((resolve) => { releaseIdle = resolve; });
    const sendStatuses: string[] = [];
    host.harness.sdk.stub("threads.wait", (async () => {
      if (status === "active") await idle;
      return { matched: true };
    }) as never);
    host.harness.sdk.stub("threads.send", (async () => {
      sendStatuses.push(status);
      status = "active";
      return { ok: true };
    }) as never);
    await plugin(host.bb);

    const thread = makeThreadResponse({ id: "worker-brief", projectId: "project-brief", status: "idle" });
    const deliveries = [
      host.harness.emitThreadEvent("thread.created", { thread }),
      host.harness.emitThreadEvent("thread.created", { thread }),
    ];
    await vi.waitFor(() => expect(host.harness.inspection.sdk.callsTo("threads.wait")).toHaveLength(2));
    expect(sendStatuses).toEqual(["idle"]);
    status = "idle";
    releaseIdle();
    await expect(Promise.all(deliveries)).resolves.toEqual([{ errors: [] }, { errors: [] }]);
    expect(sendStatuses).toEqual(["idle", "idle"]);
  });

  it("logs a role-brief timeout without sending", async () => {
    const host = createFakePluginHost({ pluginId: "bb-collab" });
    host.harness.sdk.stub("projects.get", (async ({ projectId }: { projectId: string }) => project(projectId)) as never);
    host.harness.sdk.stub("threads.wait", (async () => { throw new Error("idle wait timed out"); }) as never);
    host.harness.sdk.stub("threads.send", (async () => ({ ok: true })) as never);
    await plugin(host.bb);

    await expect(host.harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "worker-timeout", projectId: "project-brief", status: "active" }) })).resolves.toEqual({ errors: [] });
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(host.harness.inspection.logEntries).toContainEqual(expect.objectContaining({
      level: "warn",
      message: "role brief seating failed for thread=worker-timeout: Error: idle wait timed out",
    }));
  });

  it("sends an already-idle role brief without consuming the timeout", async () => {
    const host = createFakePluginHost({ pluginId: "bb-collab" });
    host.harness.sdk.stub("projects.get", (async ({ projectId }: { projectId: string }) => project(projectId)) as never);
    const order: string[] = [];
    host.harness.sdk.stub("threads.wait", (async () => { order.push("idle"); return { matched: true }; }) as never);
    host.harness.sdk.stub("threads.send", (async () => { order.push("send"); return { ok: true }; }) as never);
    await plugin(host.bb);

    await expect(host.harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "worker-idle", projectId: "project-brief", status: "idle" }) })).resolves.toEqual({ errors: [] });
    expect(order).toEqual(["idle", "send"]);
    expect(host.harness.inspection.sdk.callsTo("threads.wait")).toEqual([[
      { threadId: "worker-idle", status: "idle", timeoutMs: 30_000 },
    ]]);
  });

  it("rejects a stale generated bundle", () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-collab-role-brief-"));
    try {
      const artifact = join(directory, "role-briefs.json");
      writeFileSync(artifact, readFileSync(join(root, "dist", "role-briefs.json"), "utf8").replace("# Ponytail", "# Stale Ponytail"));
      expect(() => execFileSync(process.execPath, [join(root, "scripts", "role-brief-bundle.mjs"), artifact], { cwd: root, stdio: "pipe" })).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
