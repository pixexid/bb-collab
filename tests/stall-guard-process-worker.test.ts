import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, it } from "vitest";
import { createStallGuardCycle } from "../src/stall-guard.js";
import { PLUGIN_ID } from "../src/foundation.js";

const statePath = process.env.STALL_GUARD_PROCESS_STATE;
const resultPath = process.env.STALL_GUARD_PROCESS_RESULT;

describe.skipIf(!statePath || !resultPath)("stall-guard process worker", () => {
  it("runs one persisted cycle", async () => {
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
    if (existsSync(statePath!)) {
      const state = JSON.parse(readFileSync(statePath!, "utf8")) as Record<string, unknown>;
      await host.bb.storage.kv.set("stall-guard.artifacts", state);
    }
    const sends: unknown[] = [];
    const cycle = createStallGuardCycle({
      readRoleHolders: () => [{
        project_id: "project-1",
        role_id: "project-orchestrator",
        role_generation: 1,
        execution_attempt_id: "attempt-1",
        thread_id: "current-holder",
      }],
      readArtifact: async () => ({ outcome: "available", pullRequest: { number: 112, updatedAt: "changed", checks: { state: "passing" } } }),
      readRoleScopes: () => [{ projectId: "project-1", nextStartable: true, queueHeadId: "queue-head", deferredReason: null }],
      wakeRole: async (role) => { sends.push(role); return { attempted: true, delivered: true }; },
      persistence: {
        read: () => host.bb.storage.kv.get<unknown>("stall-guard.artifacts"),
        write: (state) => host.bb.storage.kv.set("stall-guard.artifacts", state),
      },
    });
    const summary = await cycle.cycle("project-1");
    const persisted = await host.bb.storage.kv.get<unknown>("stall-guard.artifacts");
    writeFileSync(statePath!, JSON.stringify(persisted));
    writeFileSync(resultPath!, JSON.stringify({ summary, sends: sends.length, persisted }));
    if (process.env.STALL_GUARD_PROCESS_HOLD === "1") await new Promise(() => {});
    await host.harness.lifecycle.dispose();
  });
});
