import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFleetLullWaker, readFleetLullPredicate } from "../src/fleet-lull-wait.js";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE project_config_heads (project_id TEXT PRIMARY KEY);
    CREATE TABLE role_generation_heads (project_id TEXT, role_id TEXT, domain_id TEXT, current_generation INTEGER);
    CREATE TABLE role_generations (project_id TEXT, role_id TEXT, domain_id TEXT, generation INTEGER, status TEXT, holder_execution_attempt_id TEXT);
    CREATE TABLE execution_attempts (project_id TEXT, execution_attempt_id TEXT, origin TEXT, role_id TEXT, role_generation INTEGER, state TEXT, thread_id TEXT, lease_owner_thread_id TEXT, lease_expires_at_ms INTEGER);
  `);
  db.prepare("INSERT INTO project_config_heads VALUES (?)").run("tenant-a");
  db.prepare("INSERT INTO project_config_heads VALUES (?)").run("tenant-omitted-from-project-list");
  db.prepare("INSERT INTO role_generation_heads VALUES (?, ?, ?, ?)").run("tenant-a", "director", "default", 1);
  db.prepare("INSERT INTO role_generations VALUES (?, ?, ?, ?, ?, ?)").run("tenant-a", "director", "default", 1, "active", "director-attempt");
  db.prepare("INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("tenant-a", "director-attempt", "role_holder", "director", 1, "done", "director-thread", null, null);
  db.prepare("INSERT INTO role_generation_heads VALUES (?, ?, ?, ?)").run("tenant-a", "worker", "default", 1);
  db.prepare("INSERT INTO role_generations VALUES (?, ?, ?, ?, ?, ?)").run("tenant-a", "worker", "default", 1, "active", "worker-attempt");
  db.prepare("INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("tenant-a", "worker-attempt", "role_holder", "worker", 1, "done", "caller-thread", "caller-thread", null);
  return db;
}

describe("all-tenant fleet lull", () => {
  afterEach(() => vi.useRealTimers());

  it("uses canonical tenants, excludes the caller, wakes on a signal, and distinguishes timeout", async () => {
    const db = fixture();
    const caller = readFleetLullPredicate(db, "caller-thread");
    expect(caller).toMatchObject({ outcome: "satisfied", projectIds: ["tenant-a", "tenant-omitted-from-project-list"] });
    db.prepare("UPDATE execution_attempts SET thread_id = 'foreign-thread', lease_owner_thread_id = 'foreign-thread' WHERE execution_attempt_id = 'worker-attempt'").run();
    expect(readFleetLullPredicate(db, "caller-thread").outcome).toBe("unsatisfied");

    const persisted: unknown = undefined;
    let state = persisted;
    const wakes: string[] = [];
    const now = { value: 1_000 };
    const waker = createFleetLullWaker({
      db,
      persistence: { read: async () => state, write: async (next) => { state = next; } },
      now: () => now.value,
      wake: async (_wait, reason) => { wakes.push(reason); },
    });
    await waker.register({ waitId: "wait-1", projectId: "tenant-a", waiterThreadId: "caller-thread", excludedThreadId: "caller-thread", deadlineAtMs: 10_000 });
    expect(wakes).toEqual([]);
    db.prepare("UPDATE execution_attempts SET thread_id = 'caller-thread', lease_owner_thread_id = 'caller-thread' WHERE execution_attempt_id = 'worker-attempt'").run();
    await waker.signal();
    expect(wakes).toEqual(["satisfied"]);

    db.prepare("UPDATE execution_attempts SET thread_id = 'foreign-thread', lease_owner_thread_id = 'foreign-thread' WHERE execution_attempt_id = 'worker-attempt'").run();
    const timeout = createFleetLullWaker({
      db,
      persistence: { read: async () => undefined, write: async () => {} },
      wake: async (_wait, reason) => { wakes.push(reason); },
      now: () => now.value,
    });
    await timeout.register({ waitId: "wait-2", projectId: "tenant-a", waiterThreadId: "caller-thread", excludedThreadId: "caller-thread", deadlineAtMs: 2_000 });
    now.value = 2_001;
    await timeout.signal();
    expect(wakes).toEqual(["satisfied", "timeout"]);
    db.close();
  });
});
