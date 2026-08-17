import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import plugin from "../server.js";
import { type RoleHolderState } from "../src/awareness.js";
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

function persistence() {
  let value: unknown;
  return {
    read: async () => value,
    write: async (next: unknown) => { value = structuredClone(next); },
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
    const cycle = createStallGuardCycle({
      readRoleHolders: () => holders,
      readArtifact: async () => currentArtifact,
      readRoleScopes: () => [{ projectId: PROJECT_ID, nextStartable: true, queueHeadId: "queue-head", deferredReason: null }],
      steerRole: async (role) => { steers.push(role); return true; },
      persistence: persistence(),
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

  it("does not tell a retired or archived holder when the existing seam refuses it", async () => {
    const steerRole = vi.fn().mockResolvedValue(false);
    const cycle = createStallGuardCycle({
      readRoleHolders: () => [holder(1, "retired-holder")],
      readArtifact: async () => artifact("changed"),
      readRoleScopes: () => [{ projectId: PROJECT_ID, nextStartable: true, queueHeadId: "queue-head", deferredReason: null }],
      steerRole,
      persistence: persistence(),
    });

    await cycle.cycle(PROJECT_ID);
    expect(steerRole).not.toHaveBeenCalled();
  });

  it("persists artifact deltas so a restart does not re-fire them", async () => {
    const store = persistence();
    const steerRole = vi.fn().mockResolvedValue(true);
    let currentArtifact: unknown = { outcome: "absent" };
    const options = {
      readRoleHolders: () => [holder(1, "current-holder")],
      readArtifact: async () => currentArtifact,
      readRoleScopes: () => [{ projectId: PROJECT_ID, nextStartable: true, queueHeadId: "queue-head", deferredReason: null }],
      steerRole,
      persistence: store,
    };

    await createStallGuardCycle(options).cycle(PROJECT_ID);
    currentArtifact = artifact("changed");
    await createStallGuardCycle(options).cycle(PROJECT_ID);
    await createStallGuardCycle(options).cycle(PROJECT_ID);

    expect(steerRole).toHaveBeenCalledTimes(1);
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
