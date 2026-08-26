import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFleetLullWaker, readFleetLullPredicate } from "../src/fleet-lull-wait.js";

type FixtureOptions = { activeWorkerSeat?: boolean; nonInertAttempt?: boolean; liveLease?: boolean };

function fixture(options: FixtureOptions = {}) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE project_config_heads (project_id TEXT PRIMARY KEY);
    CREATE TABLE role_generation_heads (project_id TEXT, role_id TEXT, domain_id TEXT, current_generation INTEGER);
    CREATE TABLE role_generations (project_id TEXT, role_id TEXT, domain_id TEXT, generation INTEGER, status TEXT, holder_execution_attempt_id TEXT);
    CREATE TABLE execution_attempts (project_id TEXT, execution_attempt_id TEXT, origin TEXT, role_id TEXT, role_generation INTEGER, state TEXT, thread_id TEXT, lease_owner_thread_id TEXT, lease_expires_at_ms INTEGER);
  `);
  db.prepare("INSERT INTO project_config_heads VALUES (?)").run("tenant-a");
  db.prepare("INSERT INTO project_config_heads VALUES (?)").run("tenant-omitted-from-project-list");
  if (options.activeWorkerSeat) {
    db.prepare("INSERT INTO role_generation_heads VALUES (?, ?, ?, ?)").run("tenant-a", "worker", "default", 1);
    db.prepare("INSERT INTO role_generations VALUES (?, ?, ?, ?, ?, ?)").run("tenant-a", "worker", "default", 1, "active", "worker-attempt");
    db.prepare("INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("tenant-a", "worker-attempt", "role_holder", "worker", 1, "done", "foreign-worker", null, null);
  }
  if (options.nonInertAttempt) {
    db.prepare("INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("tenant-a", "work-attempt", "work_item", "worker", 1, "running", "foreign-attempt", null, null);
  }
  if (options.liveLease) {
    db.prepare("INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("tenant-a", "leased-attempt", "work_item", "worker", 1, "done", null, "foreign-lease", 10_000);
  }
  return db;
}

describe("all-tenant fleet lull predicate", () => {
  it.each([
    ["active worker seats", { activeWorkerSeat: true }, "activeWorkerSeats"],
    ["non-inert attempts", { nonInertAttempt: true }, "nonInertAttempts"],
    ["live leases", { liveLease: true }, "liveLeases"],
  ] as const)("requires zero %s independently", (_name, options, field) => {
    const db = fixture(options);
    const predicate = readFleetLullPredicate(db, "caller-thread", 1_000);
    expect(predicate.outcome).toBe("unsatisfied");
    expect(predicate[field]).toHaveLength(1);
    expect(predicate.activeWorkerSeats).toHaveLength(field === "activeWorkerSeats" ? 1 : 0);
    expect(predicate.nonInertAttempts).toHaveLength(field === "nonInertAttempts" ? 1 : 0);
    expect(predicate.liveLeases).toHaveLength(field === "liveLeases" ? 1 : 0);
    db.close();
  });

  it("uses canonical tenants and excludes the caller", () => {
    const db = fixture();
    db.prepare("INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("tenant-a", "caller-attempt", "work_item", "worker", 1, "running", "caller-thread", "caller-thread", 10_000);
    expect(readFleetLullPredicate(db, "caller-thread", 1_000)).toMatchObject({ outcome: "satisfied", projectIds: ["tenant-a", "tenant-omitted-from-project-list"] });
    db.close();
  });

  it("returns canonical-store failure instead of registering an unknown predicate", async () => {
    let state: unknown;
    const waker = createFleetLullWaker({
      db: null,
      persistence: { read: async () => state, write: async (next) => { state = next; } },
      wake: async () => { throw new Error("wake must not run for unknown predicate"); },
      now: () => 1_000,
    });
    await expect(waker.register({ waitId: "unknown-1", projectId: "tenant-a", waiterThreadId: "caller-thread", excludedThreadId: "caller-thread", deadlineAtMs: 10_000 })).resolves.toEqual({
      outcome: "CANONICAL_STORE_UNAVAILABLE",
      message: "canonical-store-unavailable",
    });
  });
});

describe("all-tenant fleet lull wake", () => {
  afterEach(() => vi.useRealTimers());

  it("wakes on a signal, distinguishes timeout, and retries a failed delivery", async () => {
    const db = fixture({ nonInertAttempt: true });
    let state: unknown;
    const wakes: string[] = [];
    const now = { value: 1_000 };
    let attempts = 0;
    const waker = createFleetLullWaker({
      db,
      persistence: { read: async () => state, write: async (next) => { state = next; } },
      now: () => now.value,
      wake: async (_wait, reason) => {
        attempts += 1;
        if (attempts === 1) throw new Error("delivery failed");
        wakes.push(reason);
      },
    });
    await waker.register({ waitId: "wait-1", projectId: "tenant-a", waiterThreadId: "caller-thread", excludedThreadId: "caller-thread", deadlineAtMs: 10_000 });
    db.prepare("UPDATE execution_attempts SET thread_id = NULL, lease_owner_thread_id = NULL WHERE execution_attempt_id = 'work-attempt'").run();
    await expect(waker.signal()).rejects.toThrow("delivery failed");
    expect(wakes).toEqual([]);
    await waker.signal();
    expect(wakes).toEqual(["satisfied"]);

    const timeout = createFleetLullWaker({
      db,
      persistence: { read: async () => undefined, write: async () => {} },
      wake: async (_wait, reason) => { wakes.push(reason); },
      now: () => now.value,
    });
    db.prepare("UPDATE execution_attempts SET thread_id = 'foreign-attempt' WHERE execution_attempt_id = 'work-attempt'").run();
    await timeout.register({ waitId: "wait-2", projectId: "tenant-a", waiterThreadId: "caller-thread", excludedThreadId: "caller-thread", deadlineAtMs: 2_000 });
    now.value = 2_001;
    await timeout.signal();
    expect(wakes).toEqual(["satisfied", "timeout"]);
    db.close();
  });
});
