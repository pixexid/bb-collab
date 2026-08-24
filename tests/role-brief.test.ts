import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost, makeThreadResponse } from "@bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../server.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function project(projectId: string) {
  return { id: projectId, name: "Brief project", sources: [{ id: "source-main" }] };
}

describe("role briefs", () => {
  it("composes slim prompts with canonical reading order", async () => {
    const host = createFakePluginHost({ pluginId: "bb-collab" });
    host.harness.sdk.stub("projects.get", (async ({ projectId }: { projectId: string }) => project(projectId)) as never);
    await plugin(host.bb);

    for (const role of ["director", "orchestrator", "worker"] as const) {
      const brief = await host.harness.callRpc("roleBrief", { projectId: "project-brief", role }) as {
        role: string;
        roleContent: string;
        ponytail: string;
        rules: string;
        prompt: string;
      };
      expect(brief).toMatchObject({
        role,
        project: { id: "project-brief", name: "Brief project", sourceIds: ["source-main"] },
        pointers: { canonicalStoreQuery: "role_generation_heads joined to role_generations", currentSeats: [] },
        ponytail: expect.stringContaining("Does this need to exist at all?"),
        roleContent: expect.stringContaining(`# ${role === "orchestrator" ? "Orchestrator" : role[0].toUpperCase() + role.slice(1)}`),
        rules: expect.stringContaining("the deletion mandate forbids CEREMONY"),
      });
      expect(Buffer.byteLength(brief.prompt, "utf8")).toBeLessThan(4_000);
      expect(brief.prompt).toContain(brief.ponytail.trimEnd());
      expect(brief.prompt).toContain(brief.roleContent.trimEnd());
      expect(brief.roleContent).toContain("../rules.md#waiting-is-a-subscription");
      expect(brief.roleContent).not.toContain("../rules.md#silence-is-a-defect-signal");
      expect(brief.rules).not.toContain("re-ask once");
      expect(brief.prompt).toContain("Seat brief injection: Waiting is a subscription, not a loop.");
      expect(brief.prompt).toContain("All seats end turns; one bounded named same-turn director/orchestrator forensic read per incident.");
      expect(brief.prompt).toContain("BUSY-POLLING is P2 process finding; Tier-A review briefs state it.");
      expect(brief.prompt).toContain("Stop is not queue cancellation: clear and verify the exact queue before stopping when payload must not run.");
      expect(brief.prompt).toContain(`docs/roles/${role}.md, docs/operations-model.md, docs/ponytail.md, docs/rules.md, docs/threat-model.md.`);
      expect(brief.prompt).toContain("project=Brief project (project-brief); sources=source-main; canonical=role_generation_heads joined to role_generations; handoff=~/.bb/thread-storage/<threadId>/handoff.md; seats=none");
      expect(brief.prompt).not.toContain("the deletion mandate forbids CEREMONY");
    }
  });

  it("queues a created worker brief while its first turn is active", async () => {
    const host = createFakePluginHost({ pluginId: "bb-collab" });
    host.harness.sdk.stub("projects.get", (async ({ projectId }: { projectId: string }) => project(projectId)) as never);
    host.harness.sdk.stub("threads.wait", (async () => { throw new Error("must not wait for first-turn seating"); }) as never);
    host.harness.sdk.stub("threads.send", (async () => ({ ok: true })) as never);
    await plugin(host.bb);

    await expect(host.harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "worker-brief", projectId: "project-brief", status: "active" }) })).resolves.toEqual({ errors: [] });
    const request = host.harness.inspection.sdk.callsTo("threads.send")[0]?.[0] as { threadId: string; mode: string; input: Array<{ visibility: string; text: string }> };
    expect(request).toMatchObject({ threadId: "worker-brief", mode: "queue-if-active" });
    expect(request.input[0]).toMatchObject({ visibility: "agent-only", text: expect.stringContaining("Does this need to exist at all?") });
    expect(host.harness.inspection.sdk.callsTo("threads.wait")).toHaveLength(0);
  });

  it("serializes concurrent role briefs without waiting for idle", async () => {
    const host = createFakePluginHost({ pluginId: "bb-collab" });
    host.harness.sdk.stub("projects.get", (async ({ projectId }: { projectId: string }) => project(projectId)) as never);
    const sendStatuses: string[] = [];
    let status: "idle" | "active" = "idle";
    host.harness.sdk.stub("threads.wait", (async () => { throw new Error("must not wait for seating"); }) as never);
    host.harness.sdk.stub("threads.send", (async () => {
      sendStatuses.push(status);
      status = "active";
      return { ok: true };
    }) as never);
    await plugin(host.bb);

    const thread = makeThreadResponse({ id: "worker-brief", projectId: "project-brief", status: "active" });
    await expect(Promise.all([
      host.harness.emitThreadEvent("thread.created", { thread }),
      host.harness.emitThreadEvent("thread.created", { thread }),
    ])).resolves.toEqual([{ errors: [] }, { errors: [] }]);
    expect(sendStatuses).toEqual(["idle", "active"]);
    expect(host.harness.inspection.sdk.callsTo("threads.wait")).toHaveLength(0);
  });

  it("logs a role-brief send failure at error level", async () => {
    const host = createFakePluginHost({ pluginId: "bb-collab" });
    host.harness.sdk.stub("projects.get", (async ({ projectId }: { projectId: string }) => project(projectId)) as never);
    host.harness.sdk.stub("threads.send", (async () => { throw new Error("send failed"); }) as never);
    await plugin(host.bb);

    await expect(host.harness.emitThreadEvent("thread.created", { thread: makeThreadResponse({ id: "worker-failure", projectId: "project-brief", status: "active" }) })).resolves.toEqual({ errors: [] });
    expect(host.harness.inspection.logEntries).toContainEqual(expect.objectContaining({
      level: "error",
      message: "role brief seating failed for thread=worker-failure: Error: send failed",
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
    expect(order).toEqual(["send"]);
    expect(host.harness.inspection.sdk.callsTo("threads.wait")).toHaveLength(0);
  });

  it("discriminates native queue-stop ordering and clear-before-stop safety", async () => {
    const threadId = "native-stop-order";
    const sdkForNativeEvents = (nativeEvents: readonly { type: string }[]) => {
      const host = createFakePluginHost({ pluginId: "bb-collab" });
      const queue: Array<{ id: string }> = [];
      host.harness.sdk.stub("threads.queuedMessages.create", (async () => {
        const message = { id: `queued-${queue.length + 1}` };
        queue.push(message);
        return message;
      }) as never);
      host.harness.sdk.stub("threads.queuedMessages.list", (async () => [...queue]) as never);
      host.harness.sdk.stub("threads.queuedMessages.delete", (async ({ queuedMessageId }: { queuedMessageId: string }) => {
        const index = queue.findIndex(({ id }) => id === queuedMessageId);
        if (index >= 0) queue.splice(index, 1);
        return { ok: true };
      }) as never);
      host.harness.sdk.stub("threads.stop", (async () => ({ ok: true })) as never);
      host.harness.sdk.stub("threads.events.list", (async ({ types }: { types?: readonly string[] }) =>
        nativeEvents.filter((event) => types === undefined || types.includes(event.type))) as never);
      return host;
    };

    const race = sdkForNativeEvents([{ type: "turn/started" }]);
    await race.bb.sdk.threads.queuedMessages.create({
      threadId,
      input: [{ type: "text", text: "payload", mentions: [] }],
    });
    await race.bb.sdk.threads.stop({ threadId });
    const startedAfterStop = await race.bb.sdk.threads.events.list({ threadId, types: ["turn/started"] });
    expect(startedAfterStop).toHaveLength(1);
    expect(race.harness.inspection.sdk.calls.map(({ path }) => path)).toEqual([
      "threads.queuedMessages.create",
      "threads.stop",
      "threads.events.list",
    ]);

    const safe = sdkForNativeEvents([]);
    await safe.bb.sdk.threads.queuedMessages.create({
      threadId,
      input: [{ type: "text", text: "payload", mentions: [] }],
    });
    for (const message of await safe.bb.sdk.threads.queuedMessages.list({ threadId })) {
      await safe.bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId: message.id });
    }
    expect(await safe.bb.sdk.threads.queuedMessages.list({ threadId })).toEqual([]);
    await safe.bb.sdk.threads.stop({ threadId });
    const startedAfterClear = await safe.bb.sdk.threads.events.list({ threadId, types: ["turn/started"] });
    expect(startedAfterClear).toEqual([]);
    expect(safe.harness.inspection.sdk.calls.map(({ path }) => path)).toEqual([
      "threads.queuedMessages.create",
      "threads.queuedMessages.list",
      "threads.queuedMessages.delete",
      "threads.queuedMessages.list",
      "threads.stop",
      "threads.events.list",
    ]);
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
