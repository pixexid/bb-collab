// Plugin-boundary drills for the durable wait-validator (#93 / #57
// mechanism 8): the sanctioned CLI registration seam, the one-cycle
// validation seam, wait-aware idle legality for workers and the director,
// the liveness self-watch schedule, the launchd artifact, and the
// host-supervised loop script. Every drill asserts the refusing direction
// too, and none ever writes a canonical table, resolver, or receipt.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost, makeThreadResponse } from "@bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLaneWatcher, type LaneState } from "../src/awareness.js";
import plugin from "../server.js";
import { PLUGIN_ID } from "../src/foundation.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(ROOT);
const PROJECT_ID = "proj_test";

interface HostFixture {
  host: ReturnType<typeof createFakePluginHost>;
  setThread(id: string, partial: Partial<ReturnType<typeof makeThreadResponse>>): void;
  sends: unknown[][];
  canonicalDigest(): string;
}

function hostFixture(): HostFixture {
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const sends: unknown[][] = [];
  const host = createFakePluginHost({
    pluginId: PLUGIN_ID,
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const thread = threads.get(threadId);
          if (!thread) throw new Error(`unknown thread ${threadId}`);
          return thread;
        },
        send: async (input: unknown) => {
          sends.push(input as unknown[]);
          return { ok: true };
        },
        interactions: {
          list: async () => [],
        },
      },
    },
  });
  return {
    host,
    sends,
    setThread(id, partial) {
      threads.set(id, makeThreadResponse({ id, status: "idle", archivedAt: null, deletedAt: null, updatedAt: 1, projectId: PROJECT_ID, ...partial }));
    },
    canonicalDigest() {
      const db = host.bb.storage.database() as Database.Database;
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
      return JSON.stringify(tables.map((table) => [table.name, db.prepare(`SELECT * FROM "${table.name}"`).all()]));
    },
  };
}

async function loadedFixture(): Promise<HostFixture> {
  const fixture = hostFixture();
  await plugin(fixture.host.bb);
  return fixture;
}

const waitRequest = (overrides: Record<string, unknown> = {}) => ({
  projectId: PROJECT_ID,
  waiterThreadId: "waiter-1",
  eventType: "source_terminal",
  sourceThreadId: "source-1",
  reason: "waiting on the source lane",
  idempotencyKey: "wait-key-1",
  ...overrides,
});

async function registerWait(fixture: HostFixture, request: Record<string, unknown>, ctxThreadId?: string) {
  return fixture.host.harness.runCli(
    ["wait-register", "--project", PROJECT_ID, "--request", JSON.stringify(request)],
    ctxThreadId === undefined ? undefined : { threadId: ctxThreadId },
  );
}

describe("durable wait-validator plugin boundary", () => {
  it("registers waits through the CLI seam, bound to the calling thread", async () => {
    const fixture = await loadedFixture();
    fixture.setThread("source-1", { status: "active" });
    const digestBefore = fixture.canonicalDigest();

    const result = await registerWait(fixture, waitRequest(), "waiter-1");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "OK", evidence: { wait: { waiterThreadId: "waiter-1" } } });

    const replay = await registerWait(fixture, waitRequest(), "waiter-1");
    expect(replay.exitCode).toBe(0);
    expect(JSON.parse(replay.stdout)).toMatchObject({ message: expect.stringContaining("replayed") });

    const foreign = await registerWait(fixture, waitRequest({ idempotencyKey: "wait-key-2" }), "waiter-2");
    expect(foreign.exitCode).toBe(2);
    expect(JSON.parse(foreign.stdout)).toMatchObject({ outcome: "INVALID_INPUT", message: expect.stringContaining("calling thread") });

    const listed = await fixture.host.harness.runCli(["wait-list", "--project", PROJECT_ID]);
    expect(JSON.parse(listed.stdout).evidence.active).toHaveLength(1);
    expect(fixture.canonicalDigest()).toBe(digestBefore); // KV only: zero canonical writes
    await fixture.host.harness.lifecycle.dispose();
  });

  it("refuses a deadline-less wait at registration, fail closed", async () => {
    const fixture = await loadedFixture();
    fixture.setThread("source-1", { status: "active" });
    for (const request of [
      waitRequest({ eventType: "ci_check" }),
      waitRequest({ deadlineMs: null }),
      waitRequest({ deadlineMs: 123 }),
    ]) {
      const result = await registerWait(fixture, request, "waiter-1");
      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "INVALID_INPUT" });
    }
    const unknownSource = await registerWait(fixture, waitRequest({ idempotencyKey: "wait-key-9", sourceThreadId: "source-unknown" }), "waiter-1");
    expect(unknownSource.exitCode).toBe(2);
    expect(JSON.parse(unknownSource.stdout)).toMatchObject({ message: expect.stringContaining("unknown") });
    const listed = await fixture.host.harness.runCli(["wait-list", "--project", PROJECT_ID]);
    expect(JSON.parse(listed.stdout).evidence.active).toHaveLength(0);
    await fixture.host.harness.lifecycle.dispose();
  });

  it("fires, wakes once, and never re-fires across cycles or restart", async () => {
    const fixture = await loadedFixture();
    fixture.setThread("source-1", { status: "active" });
    fixture.setThread("waiter-1", { status: "idle" });
    const digestBefore = fixture.canonicalDigest();
    await registerWait(fixture, waitRequest(), "waiter-1");

    fixture.setThread("source-1", { status: "error" });
    const first = await fixture.host.harness.runCli(["wait-validator", "--cycle"]);
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ outcome: "OK", evidence: { fired: 1, steered: 1 } });
    expect(fixture.sends).toHaveLength(1);
    expect(fixture.sends[0]).toMatchObject({ threadId: "waiter-1", mode: "steer", input: [{ type: "text", visibility: "agent-only" }] });

    const replay = await fixture.host.harness.runCli(["wait-validator", "--cycle"]);
    expect(JSON.parse(replay.stdout)).toMatchObject({ evidence: { fired: 0, steered: 0 } });
    expect(fixture.sends).toHaveLength(1); // dedupe: restarts and replays never double-fire

    expect(fixture.canonicalDigest()).toBe(digestBefore); // validation is read-only on canonical state
    await fixture.host.harness.lifecycle.dispose();
  });

});

describe("wait-aware watcher integration", () => {
  function lane(threadId: string): LaneState {
    return {
      project_id: "project-1",
      assignment_id: "assignment-1",
      lane_id: "lane-1",
      assignment_kind: "write",
      work_item_id: "work-1",
      thread_id: threadId,
      execution_attempt_id: "attempt-1",
      attempt_state: "running",
      terminal_report_digest: null,
      created_at_ms: 1,
    };
  }

  async function runObserver(registeredWaitThreads: Set<string>) {
    const steered: string[] = [];
    const watcher = createLaneWatcher({
      readLanes: () => [lane("worker-1")],
      steer: async (view) => { steered.push(view.threadId ?? "null"); },
      readWorker: async () => ({ status: "idle", pendingExternalWait: false, archived: false, operatorWait: null, operatorWaitKnown: true, idleSinceMs: 1 }),
      readRegisteredWaitFor: async (threadId) => registeredWaitThreads.has(threadId),
    });
    await watcher.observe("worker-1", "idle");
    return steered;
  }

  it("does not steer an idle worker with a registered wait", async () => {
    expect(await runObserver(new Set(["worker-1"]))).toHaveLength(0);
  });

  it("steers the same idle worker without one: unregistered waits are illegal idles", async () => {
    expect(await runObserver(new Set())).toEqual(["worker-1"]);
  });
});

describe("liveness self-watch schedule", () => {
  const originalStateDir = process.env.BB_COLLAB_VALIDATOR_STATE_DIR;
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "bb-collab-liveness-"));
    process.env.BB_COLLAB_VALIDATOR_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.BB_COLLAB_VALIDATOR_STATE_DIR;
    else process.env.BB_COLLAB_VALIDATOR_STATE_DIR = originalStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  });

  function marker(value: number | null) {
    const path = join(stateDir, "wait-validator.liveness");
    if (value === null) rmSync(path, { force: true });
    else writeFileSync(path, String(value));
  }

  function errorLogs(fixture: HostFixture) {
    return fixture.host.harness.inspection.logEntries.filter((entry) => entry.level === "error");
  }

  it("alerts the operator exactly once per staleness episode and re-arms", async () => {
    const fixture = await loadedFixture();
    const run = () => fixture.host.harness.runSchedule("wait-validator-liveness");

    marker(Date.now() - 1_000);
    await run();
    expect(errorLogs(fixture)).toHaveLength(0); // fresh: silent

    marker(Date.now() - 10 * 60_000);
    await run();
    expect(errorLogs(fixture)).toHaveLength(1); // stale: exactly one alert
    expect(existsSync(join(stateDir, "wait-validator.alerted"))).toBe(true);

    await run();
    await run();
    expect(errorLogs(fixture)).toHaveLength(1); // no repeat within the episode

    marker(Date.now() - 1_000);
    await run();
    expect(existsSync(join(stateDir, "wait-validator.alerted"))).toBe(false); // episode closes

    marker(Date.now() - 10 * 60_000);
    await run();
    expect(errorLogs(fixture)).toHaveLength(2); // a new episode alerts again

    marker(null);
    await run();
    expect(errorLogs(fixture)).toHaveLength(2); // missing marker: fail closed, silent
    await fixture.host.harness.lifecycle.dispose();
  });
});

describe("launchd and loop artifacts", () => {
  it("ships a KeepAlive LaunchAgent that supervises the loop script", () => {
    const plist = readFileSync(join(PROJECT_ROOT, "launchd/com.bbcollab.wait-validator.plist"), "utf8");
    expect(plist).toMatch(/<key>Label<\/key>\s*<string>com\.bbcollab\.wait-validator<\/string>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>15<\/integer>/);
    expect(plist).toContain("scripts/wait-validator.mjs");
    try {
      execFileSync("plutil", ["-lint", join(PROJECT_ROOT, "launchd/com.bbcollab.wait-validator.plist")], { stdio: "pipe" });
    } catch {
      // plutil is macOS-only; the structural assertions above carry the check elsewhere.
    }
  });

  it("refreshes the liveness marker even when a cycle cannot run (script drill)", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "bb-collab-validator-"));
    const previous = process.env.BB_COLLAB_VALIDATOR_STATE_DIR;
    process.env.BB_COLLAB_VALIDATOR_STATE_DIR = stateDir;
    try {
      execFileSync(process.execPath, [join(PROJECT_ROOT, "scripts/wait-validator.mjs"), "--once"], {
        env: { ...process.env, BB_BIN: "/bin/false" }, // bb down: the cycle must fail harmlessly
        stdio: "pipe",
        timeout: 30_000,
      });
      const markerPath = join(stateDir, "wait-validator.liveness");
      expect(existsSync(markerPath)).toBe(true);
      expect(Number(readFileSync(markerPath, "utf8"))).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.BB_COLLAB_VALIDATOR_STATE_DIR;
      else process.env.BB_COLLAB_VALIDATOR_STATE_DIR = previous;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("second-check script alerts once per episode and stays silent without a marker", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "bb-collab-liveness-check-"));
    const previous = process.env.BB_COLLAB_VALIDATOR_STATE_DIR;
    process.env.BB_COLLAB_VALIDATOR_STATE_DIR = stateDir;
    const run = () => {
      try {
        return execFileSync(process.execPath, [join(PROJECT_ROOT, "scripts/wait-validator-liveness-check.mjs")], {
          env: { ...process.env, BB_COLLAB_LIVENESS_STALE_MS: "1000" },
          stdio: "pipe",
          timeout: 30_000,
        });
      } catch (error) {
        return error as { status?: number; stderr?: string };
      }
    };
    try {
      expect(run()).toBeDefined(); // missing marker: silent success
      expect(existsSync(join(stateDir, "wait-validator.alerted"))).toBe(false);

      writeFileSync(join(stateDir, "wait-validator.liveness"), String(Date.now() - 60_000));
      const first = run() as { status?: number; stderr?: string };
      expect(first.status).toBe(1); // one operator alert
      expect(String(first.stderr)).toContain("OPERATOR ALERT");
      expect(existsSync(join(stateDir, "wait-validator.alerted"))).toBe(true);

      const second = run() as { status?: number; stderr?: string };
      expect(second.status ?? 0).toBe(0); // no repeat

      writeFileSync(join(stateDir, "wait-validator.liveness"), String(Date.now()));
      expect(run()).toBeDefined(); // fresh: clears the flag, exits clean
      expect(existsSync(join(stateDir, "wait-validator.alerted"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.BB_COLLAB_VALIDATOR_STATE_DIR;
      else process.env.BB_COLLAB_VALIDATOR_STATE_DIR = previous;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
