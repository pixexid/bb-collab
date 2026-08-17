import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import plugin from "../server.js";
import { createLaneWatcher, type RoleHolderState } from "../src/awareness.js";
import { PLUGIN_ID } from "../src/foundation.js";
import { createStallGuardCycle } from "../src/stall-guard.js";

const PROJECT_ID = "project-1";

function holder(generation: number, threadId: string): RoleHolderState {
  return {
    project_id: PROJECT_ID,
    role_id: "project-orchestrator",
    role_generation: generation,
    execution_attempt_id: `attempt-${generation}`,
    thread_id: threadId,
  };
}

function kvPersistence() {
  const host = createFakePluginHost({
    pluginId: PLUGIN_ID,
    sdk: {
      threads: {
        get: async () => { throw new Error("not used"); },
        send: async () => ({ ok: true }),
        interactions: { list: async () => [] },
      },
    },
  });
  return {
    host,
    persistence: {
      read: () => host.bb.storage.kv.get<unknown>("stall-guard.artifacts"),
      write: (next: Record<string, string>) => host.bb.storage.kv.set("stall-guard.artifacts", next),
    },
  };
}

function artifact(updatedAt: string) {
  return { outcome: "available", pullRequest: { number: 112, updatedAt, checks: { state: "passing" } } };
}

describe("stall-guard artifact cycle", () => {
  it("retargets the current generation after succession without a restart", async () => {
    let holders = [holder(1, "old-holder")];
    let currentArtifact: unknown = { outcome: "absent" };
    const steers: unknown[] = [];
    const store = kvPersistence();
    const cycle = createStallGuardCycle({
      readRoleHolders: () => holders,
      readArtifact: async () => currentArtifact,
      readRoleScopes: () => [{ projectId: PROJECT_ID, nextStartable: true, queueHeadId: "queue-head", deferredReason: null }],
      wakeRole: async (role) => { steers.push(role); return true; },
      persistence: store.persistence,
    });

    await cycle.cycle(PROJECT_ID);
    currentArtifact = artifact("one");
    await cycle.cycle(PROJECT_ID);
    holders = [holder(2, "new-holder")];
    currentArtifact = artifact("two");
    await cycle.cycle(PROJECT_ID);

    expect(steers).toEqual([
      expect.objectContaining({ roleGeneration: 1, threadId: "old-holder" }),
      expect.objectContaining({ roleGeneration: 2, threadId: "new-holder" }),
    ]);
  });

  it.each(["retired", "archived"] as const)("does not tell a %s holder through the real refusal seam", async (kind) => {
    const store = kvPersistence();
    let holders = [holder(1, "current-holder")];
    let currentArtifact: unknown = { outcome: "absent" };
    const steerRole = vi.fn().mockResolvedValue(true);
    const watcher = createLaneWatcher({
      readLanes: () => [],
      steer: async () => {},
      readRoleHolders: () => holders,
      readRoleScopes: () => [{ projectId: PROJECT_ID, nextStartable: true, queueHeadId: "queue-head", deferredReason: null }],
      readWorker: async () => ({
        status: "idle",
        pendingExternalWait: false,
        archived: kind === "archived",
        projectId: PROJECT_ID,
        operatorWait: null,
        operatorWaitKnown: true,
        idleSinceMs: 0,
      }),
      steerRole,
    });
    const cycle = createStallGuardCycle({
      readRoleHolders: () => holders,
      readArtifact: async () => currentArtifact,
      readRoleScopes: () => [{ projectId: PROJECT_ID, nextStartable: true, queueHeadId: "queue-head", deferredReason: null }],
      wakeRole: (role) => watcher.wakeRole(role),
      persistence: store.persistence,
    });

    await cycle.cycle(PROJECT_ID);
    if (kind === "retired") holders = [];
    currentArtifact = artifact("changed");
    await cycle.cycle(PROJECT_ID);

    expect(steerRole).not.toHaveBeenCalled();
  });

  it("persists artifact deltas so a restart does not re-fire them", async () => {
    const store = kvPersistence();
    const wakeRole = vi.fn().mockResolvedValue(true);
    let currentArtifact: unknown = { outcome: "absent" };
    const options = {
      readRoleHolders: () => [holder(1, "current-holder")],
      readArtifact: async () => currentArtifact,
      readRoleScopes: () => [{ projectId: PROJECT_ID, nextStartable: true, queueHeadId: "queue-head", deferredReason: null }],
      wakeRole,
      persistence: store.persistence,
    };

    await createStallGuardCycle(options).cycle(PROJECT_ID);
    currentArtifact = artifact("changed");
    await createStallGuardCycle(options).cycle(PROJECT_ID);
    await createStallGuardCycle(options).cycle(PROJECT_ID);

    expect(wakeRole).toHaveBeenCalledTimes(1);
  });

  it("coalesces the idle-floor and artifact-delta paths through the ledger", async () => {
    let currentNow = 0;
    let currentArtifact: unknown = { outcome: "absent" };
    const store = kvPersistence();
    const steerRole = vi.fn().mockResolvedValue(true);
    const watcher = createLaneWatcher({
      readLanes: () => [],
      steer: async () => {},
      readRoleHolders: () => [holder(1, "current-holder")],
      readRoleScopes: () => [{ projectId: PROJECT_ID, nextStartable: true, queueHeadId: "queue-head", deferredReason: null }],
      readWorker: async () => ({
        status: "idle",
        pendingExternalWait: false,
        archived: false,
        projectId: PROJECT_ID,
        operatorWait: null,
        operatorWaitKnown: true,
        idleSinceMs: 0,
      }),
      steerRole,
      now: () => currentNow,
    });
    const cycle = createStallGuardCycle({
      readRoleHolders: () => [holder(1, "current-holder")],
      readArtifact: async () => currentArtifact,
      readRoleScopes: () => [{ projectId: PROJECT_ID, nextStartable: true, queueHeadId: "queue-head", deferredReason: null }],
      wakeRole: (role) => watcher.wakeRole(role),
      persistence: store.persistence,
    });

    await cycle.cycle(PROJECT_ID);
    await watcher.poll();
    currentNow = 10 * 60_000;
    currentArtifact = artifact("changed");
    await watcher.poll();
    const summary = await cycle.cycle(PROJECT_ID);

    expect(steerRole).toHaveBeenCalledTimes(1);
    expect(summary.steered).toBe(0);
  });
});

describe("stall-guard CLI", () => {
  it("registers the exact stall-guard command", async () => {
    const host = createFakePluginHost({
      pluginId: PLUGIN_ID,
      sdk: {
        threads: {
          get: async () => { throw new Error("no holder"); },
          send: async () => ({ ok: true }),
          interactions: { list: async () => [] },
        },
      },
    });
    await plugin(host.bb);

    const result = await host.harness.runCli(["stall-guard", "--cycle", "--project", PROJECT_ID]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "OK", subject: "stall-guard" });
    await host.harness.lifecycle.dispose();
  });
});
