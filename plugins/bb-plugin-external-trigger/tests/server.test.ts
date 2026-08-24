import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../server.js";

const projectA = { id: "project-a", kind: "standard" as const, name: "A", gitRemoteUrl: null, sources: [], createdAt: 1, updatedAt: 1 };
const projectB = { ...projectA, id: "project-b", name: "B" };
const threadA = makeThreadResponse({ id: "thread-a", projectId: projectA.id });
const threadB = makeThreadResponse({ id: "thread-b", projectId: projectB.id });

function setup() {
  let currentA = threadA;
  let currentB = threadB;
  const host = createFakePluginHost({
    pluginId: "external-trigger",
    sdk: {
      projects: { get: async ({ projectId }) => projectId === projectA.id ? projectA : projectB },
      threads: {
        get: async ({ threadId }) => threadId === threadA.id ? currentA : currentB,
        send: async () => ({ ok: true }),
      },
    },
  });
  return { host, setA: (next: typeof threadA) => { currentA = next; }, setB: (next: typeof threadB) => { currentB = next; } };
}

async function create(host: ReturnType<typeof setup>["host"], projectId: string, threadId: string, instruction: string, trigger?: string) {
  const args = ["create", "--project", projectId, "--thread", threadId, "--instruction", instruction];
  if (trigger) args.push("--trigger", trigger);
  const result = await host.harness.behavior.runCli(args);
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout);
}

async function fire(host: ReturnType<typeof setup>["host"], body: unknown) {
  return host.harness.behavior.fetchHttp("POST", "/doorbell", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("external trigger", () => {
  it("registers token auth and sends one stored instruction, idempotently", async () => {
    const { host } = setup();
    await plugin(host.bb);
    expect(host.harness.inspection.registrations.httpRoutes[0]).toMatchObject({ method: "POST", path: "/doorbell", auth: "token" });
    const trigger = await create(host, projectA.id, threadA.id, "Continue the approved task.", "trigger-a");

    const first = await fire(host, { triggerId: trigger.id, deliveryId: "event-1" });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ outcome: "sent" });
    const send = host.harness.inspection.sdk.callsTo("threads.send")[0]?.[0] as { threadId: string; mode: string; input: Array<{ text: string }> };
    expect(send.threadId).toBe(threadA.id);
    expect(send.mode).toBe("auto");
    expect(send.input[0]?.text).toBe("External event event-1 received for trigger trigger-a.\nContinue the approved task.");

    const duplicate = await fire(host, { triggerId: trigger.id, deliveryId: "event-1" });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ outcome: "duplicate" });
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("retains an ambiguous reservation and never retries it", async () => {
    const { host } = setup();
    host.harness.sdk.stub("threads.send", async () => { throw new Error("transport timeout"); });
    await plugin(host.bb);
    const trigger = await create(host, projectA.id, threadA.id, "Stored only.", "trigger-ambiguous");
    const first = await fire(host, { triggerId: trigger.id, deliveryId: "event-timeout" });
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({ outcome: "ambiguous" });
    const listed = await host.harness.behavior.runCli(["list", "--project", projectA.id]);
    expect(JSON.parse(listed.stdout)[0]).toMatchObject({ id: trigger.id, deliveryCount: 1, reservedCount: 1, sentCount: 0 });
    const replay = await fire(host, { triggerId: trigger.id, deliveryId: "event-timeout" });
    expect(await replay.json()).toMatchObject({ outcome: "duplicate" });
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });

  it("rejects identity mistakes, dead targets, caller instructions, and oversized input", async () => {
    const { host, setA } = setup();
    await plugin(host.bb);
    const mismatch = await host.harness.behavior.runCli(["create", "--project", projectA.id, "--thread", threadB.id, "--instruction", "no"]);
    expect(mismatch.exitCode).toBe(2);
    const trigger = await create(host, projectA.id, threadA.id, "Trusted instruction.", "trigger-guard");
    setA({ ...threadA, projectId: projectB.id });
    expect((await fire(host, { triggerId: trigger.id, deliveryId: "wrong-project" })).status).toBe(409);
    setA({ ...threadA, archivedAt: 1 });
    expect((await fire(host, { triggerId: trigger.id, deliveryId: "archived" })).status).toBe(409);
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    setA({ ...threadA, deletedAt: 1 });
    expect((await fire(host, { triggerId: trigger.id, deliveryId: "deleted" })).status).toBe(409);
    setA(threadA);
    expect((await fire(host, { triggerId: trigger.id, deliveryId: "caller-text", instruction: "inject" })).status).toBe(400);
    expect((await fire(host, { triggerId: trigger.id, deliveryId: "bad id" })).status).toBe(400);
    expect((await fire(host, { triggerId: trigger.id, deliveryId: "large", payload: "x".repeat(4_100) })).status).toBe(413);
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });

  it("supports an unrelated project and removal prevents future delivery", async () => {
    const { host } = setup();
    await plugin(host.bb);
    const a = await create(host, projectA.id, threadA.id, "A", "trigger-a");
    const b = await create(host, projectB.id, threadB.id, "B", "trigger-b");
    expect((await fire(host, { triggerId: b.id, deliveryId: "b-1" })).status).toBe(200);
    expect(host.harness.inspection.sdk.callsTo("threads.send").map(([args]) => (args as { threadId: string }).threadId)).toEqual([threadB.id]);
    const removed = await host.harness.behavior.runCli(["remove", "--project", projectA.id, "--trigger", a.id]);
    expect(removed.exitCode).toBe(0);
    expect((await fire(host, { triggerId: a.id, deliveryId: "a-after-remove" })).status).toBe(404);
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });
});
