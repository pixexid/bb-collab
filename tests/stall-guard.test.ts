import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      wakeRole: async (role) => { steers.push(role); return { attempted: true, delivered: true }; },
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
    const wakeRole = vi.fn().mockResolvedValue({ attempted: true, delivered: true });
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

  it("survives a SIGKILL across supervised processes with the same plugin KV", async () => {
    const root = mkdtempSync(join(tmpdir(), "bb-collab-stall-guard-process-"));
    const statePath = join(root, "plugin-kv.json");
    const firstResultPath = join(root, "first-result.json");
    const secondResultPath = join(root, "second-result.json");
    writeFileSync(statePath, JSON.stringify({ "project-1:project-orchestrator": JSON.stringify({ outcome: "absent" }) }));

    const runWorker = (resultPath: string, hold: boolean): ChildProcess => spawn(
      process.execPath,
      [join(process.cwd(), "node_modules/vitest/vitest.mjs"), "run", "tests/stall-guard-process-worker.test.ts", "--reporter=dot"],
      {
        cwd: process.cwd(),
        env: { ...process.env, STALL_GUARD_PROCESS_STATE: statePath, STALL_GUARD_PROCESS_RESULT: resultPath, STALL_GUARD_PROCESS_HOLD: hold ? "1" : "0" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const waitForResult = async (child: ChildProcess, resultPath: string) => {
      const deadline = Date.now() + 10_000;
      while (!existsSync(resultPath)) {
        if (child.exitCode !== null) throw new Error(`stall-guard worker exited ${child.exitCode}`);
        if (Date.now() >= deadline) throw new Error("stall-guard worker did not persist its result");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    let first: ChildProcess | undefined;
    try {
      first = runWorker(firstResultPath, true);
      await waitForResult(first, firstResultPath);
      const firstResult = JSON.parse(readFileSync(firstResultPath, "utf8")) as Record<string, unknown>;
      expect(firstResult).toMatchObject({ sends: 1, summary: { attempted: 1, verified: 1 } });
      expect(firstResult.persisted).toEqual(expect.objectContaining({ "project-1:project-orchestrator": expect.stringContaining('"updatedAt":"changed"') }));
      first.kill("SIGKILL");
      await once(first, "exit");
      first = undefined;

      const second = runWorker(secondResultPath, false);
      const [exitCode, stderr] = await Promise.all([
        once(second, "close").then(([code]) => code),
        new Promise<string>((resolve) => {
          let output = "";
          second.stderr?.setEncoding("utf8");
          second.stderr?.on("data", (chunk: string) => { output += chunk; });
          second.stderr?.on("end", () => resolve(output));
        }),
      ]);
      expect(exitCode, stderr).toBe(0);
      const secondResult = JSON.parse(readFileSync(secondResultPath, "utf8")) as Record<string, unknown>;
      expect(secondResult).toMatchObject({ sends: 0, summary: { attempted: 0, verified: 0 } });
      expect(secondResult.persisted).toEqual(firstResult.persisted);
    } finally {
      if (first && first.exitCode === null) first.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not verify a thrown role send, retries the delta, and escalates after the second failure", async () => {
    let currentNow = 0;
    let currentArtifact: unknown = { outcome: "absent" };
    const store = kvPersistence();
    const deliveredMessages: unknown[] = [];
    const send = vi.fn(async (_role: unknown) => { throw new Error("send failed"); });
    const steerRole = vi.fn(async (role: unknown) => {
      await send(role);
      deliveredMessages.push(role);
    });
    const succession: unknown[] = [];
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
      roleIdleThresholdMs: 0,
      now: () => currentNow,
      onRoleSuccessionRequired: (role) => succession.push(role),
    });
    const cycle = createStallGuardCycle({
      readRoleHolders: () => [holder(1, "current-holder")],
      readArtifact: async () => currentArtifact,
      readRoleScopes: () => [{ projectId: PROJECT_ID, nextStartable: true, queueHeadId: "queue-head", deferredReason: null }],
      wakeRole: (role) => watcher.wakeRole(role),
      persistence: store.persistence,
    });

    await cycle.cycle(PROJECT_ID);
    currentArtifact = artifact("changed");
    const first = await cycle.cycle(PROJECT_ID);
    currentNow = 10 * 60_000;
    const second = await cycle.cycle(PROJECT_ID);

    expect(deliveredMessages).toEqual([]);
    expect(first).toMatchObject({ attempted: 1, verified: 0, steered: 0 });
    expect(second).toMatchObject({ attempted: 1, verified: 0, steered: 0 });
    expect(steerRole).toHaveBeenCalledTimes(2);
    expect(succession).toHaveLength(1);
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
