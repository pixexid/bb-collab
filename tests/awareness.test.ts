import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
  createLaneWatcher,
  createIdleFleetDetector,
  createWaitRegistry,
  IDLE_FLEET_DEBOUNCE_MS,
  type IdleFleetDecision,
  type OperatorWait,
  type RegisteredWait,
  readRoleHolderStates,
  type RoleHolderState,
  type RoleIdleView,
} from "../src/awareness.js";

function roleHolder(threadId = "director-1"): RoleHolderState {
  return {
    project_id: "project-1",
    role_id: "project-orchestrator",
    role_generation: 3,
    execution_attempt_id: "role-attempt-3",
    thread_id: threadId,
  };
}

function roleScope(queueHeadId: string | null, deferredReason: OperatorWait["reason"] | null = null) {
  return { projectId: "project-1", nextStartable: queueHeadId !== null, queueHeadId, deferredReason };
}

function roleObservation(idleSinceMs: number): { projectId: string; status: "idle"; pendingExternalWait: false; archived: false; operatorWait: null; operatorWaitKnown: true; idleSinceMs: number } {
  return { projectId: "project-1", status: "idle", pendingExternalWait: false, operatorWait: null, operatorWaitKnown: true, archived: false, idleSinceMs };
}

const TEST_REGISTERED_WAIT_DEADLINE_AT_MS = 4_000_000_000_000;

function registeredWait(overrides: Partial<RegisteredWait> = {}): RegisteredWait {
  return {
    waitId: "wait-1",
    waiterThreadId: "worker-1",
    sourceThreadId: "source-1",
    sourceEvent: "terminal",
    deadlineAtMs: TEST_REGISTERED_WAIT_DEADLINE_AT_MS,
    wakerSchedule: null,
    declaredAtMs: null,
    ...overrides,
  };
}

describe("lane awareness", () => {
  it("detects only a startable, non-deferred queue for a role", async () => {
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<void>>().mockResolvedValue(undefined);
    let scopes = [roleScope(null, "awaiting_operator")];
    let currentNow = 0;
    const watcher = createLaneWatcher({
      readRoleHolders: () => [roleHolder()],
      readRoleScopes: () => scopes,
      readWorker: async () => roleObservation(0),
      steerRole,
      now: () => currentNow,
    });

    await watcher.poll();
    expect(steerRole).not.toHaveBeenCalled();

    scopes = [roleScope("queue-head")];
    await watcher.poll();
    currentNow = 10 * 60_000;
    await watcher.poll();
    expect(steerRole).toHaveBeenCalledTimes(1);
  });

  it("selects the current canonical holder instead of a dispatcher identity", async () => {
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<void>>().mockResolvedValue(undefined);
    const readWorker = vi.fn(async (threadId: string) => ({ ...roleObservation(0), status: threadId === "director-1" ? "idle" as const : "active" as const }));
    let currentNow = 0;
    const watcher = createLaneWatcher({
      readRoleHolders: () => [roleHolder()],
      readRoleScopes: () => [roleScope("queue-head")],
      readWorker,
      steerRole,
      now: () => currentNow,
    });

    await watcher.poll();
    currentNow = 10 * 60_000;
    await watcher.poll();

    expect(steerRole).toHaveBeenCalledWith(expect.objectContaining({ threadId: "director-1" }));
    expect(readWorker).toHaveBeenCalledWith("director-1");
  });

  it("coalesces duplicate idle observations for a startable dispatcher seat", async () => {
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<void>>().mockResolvedValue(undefined);
    let currentNow = 0;
    const watcher = createLaneWatcher({
      readRoleHolders: () => [{ ...roleHolder("dispatcher-1"), role_id: "worker" }],
      readRoleScopes: () => [roleScope("queue-head")],
      readWorker: async () => roleObservation(0),
      steerRole,
      now: () => currentNow,
    });

    await watcher.poll();
    currentNow = 10 * 60_000;
    await watcher.poll();
    await Promise.all([
      watcher.observe("dispatcher-1", "idle"),
      watcher.poll(),
    ]);

    expect(steerRole).toHaveBeenCalledTimes(1);
    expect(steerRole).toHaveBeenCalledWith(expect.objectContaining({ roleId: "worker", threadId: "dispatcher-1" }));
  });

  it("suppresses role observation when the canonical holder is ambiguous", async () => {
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<void>>().mockResolvedValue(undefined);
    const watcher = createLaneWatcher({
      readRoleHolders: () => [roleHolder("director-1"), roleHolder("director-2")],
      readRoleScopes: () => [roleScope("queue-head")],
      readWorker: async () => roleObservation(0),
      steerRole,
      now: () => 10 * 60_000,
    });

    await watcher.poll();

    expect(steerRole).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", [] as RoleHolderState[]],
  ])("refuses a %s canonical holder", async (_name, holders) => {
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<void>>().mockResolvedValue(undefined);
    const watcher = createLaneWatcher({
      readRoleHolders: () => holders,
      readRoleScopes: () => [roleScope("queue-head")],
      readWorker: async () => roleObservation(0),
      steerRole,
      now: () => 10 * 60_000,
    });

    await watcher.poll();

    expect(steerRole).not.toHaveBeenCalled();
  });

  it.each([
    ["archived", { ...roleObservation(0), archived: true }],
    ["foreign", { ...roleObservation(0), projectId: "project-2" }],
  ])("refuses an %s native holder observation", async (_name, observation) => {
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<void>>().mockResolvedValue(undefined);
    const watcher = createLaneWatcher({
      readRoleHolders: () => [roleHolder()],
      readRoleScopes: () => [roleScope("queue-head")],
      readWorker: async () => observation,
      steerRole,
      now: () => 10 * 60_000,
    });

    await watcher.poll();

    expect(steerRole).not.toHaveBeenCalled();
  });

  it("rechecks the canonical holder before steering", async () => {
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<void>>().mockResolvedValue(undefined);
    let reads = 0;
    const watcher = createLaneWatcher({
      readRoleHolders: () => {
        reads += 1;
        return [roleHolder(reads > 2 ? "successor-1" : "director-1")];
      },
      readRoleScopes: () => [roleScope("queue-head")],
      readWorker: async () => roleObservation(0),
      steerRole,
      now: () => 10 * 60_000,
    });

    await watcher.poll();

    expect(steerRole).not.toHaveBeenCalled();
  });

  it("suppresses role observation when the canonical queue scope is absent", async () => {
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<void>>().mockResolvedValue(undefined);
    const watcher = createLaneWatcher({
      readRoleHolders: () => [roleHolder()],
      readRoleScopes: () => [],
      readWorker: async () => roleObservation(0),
      steerRole,
      now: () => 10 * 60_000,
    });

    await watcher.poll();

    expect(steerRole).not.toHaveBeenCalled();
  });

  it("observes the current canonical holder from its thread event", async () => {
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<void>>().mockResolvedValue(undefined);
    let currentNow = 0;
    const watcher = createLaneWatcher({
      readRoleHolders: () => [roleHolder()],
      readRoleScopes: () => [roleScope("queue-head")],
      readWorker: async (threadId) => ({ ...roleObservation(0), status: threadId === "director-1" ? "idle" : "active" }),
      steerRole,
      now: () => currentNow,
    });

    await watcher.observe("director-1", "idle");
    currentNow = 10 * 60_000;
    await watcher.observe("director-1", "idle");

    expect(steerRole).toHaveBeenCalledWith(expect.objectContaining({ threadId: "director-1" }));
  });

  it("waits for the exact ten-minute wrongful-idle threshold", async () => {
    let currentNow = 0;
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<void>>().mockResolvedValue(undefined);
    const watcher = createLaneWatcher({
      readRoleHolders: () => [roleHolder()],
      readRoleScopes: () => [roleScope("queue-head")],
      readWorker: async () => roleObservation(0),
      steerRole,
      now: () => currentNow,
    });

    await watcher.poll();
    expect(steerRole).not.toHaveBeenCalled();
    currentNow = 10 * 60_000 - 1;
    await watcher.poll();
    expect(steerRole).not.toHaveBeenCalled();
    currentNow += 1;
    await watcher.poll();
    expect(steerRole).toHaveBeenCalledTimes(1);
  });

  it("coalesces repeated role-idle observations to one steer", async () => {
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<void>>().mockResolvedValue(undefined);
    let currentNow = 0;
    const watcher = createLaneWatcher({
      readRoleHolders: () => [roleHolder()],
      readRoleScopes: () => [roleScope("queue-head")],
      readWorker: async () => roleObservation(0),
      steerRole,
      now: () => currentNow,
    });

    await watcher.poll();
    currentNow = 10 * 60_000;
    await watcher.poll();
    expect(steerRole).toHaveBeenCalledTimes(1);
  });

  it("does not record a role steer refused by final revalidation", async () => {
    let persisted: Record<string, unknown> = {};
    let currentNow = 0;
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<boolean>>().mockResolvedValue(false);
    const watcher = createLaneWatcher({
      readRoleHolders: () => [roleHolder()],
      readRoleScopes: () => [roleScope("queue-head")],
      readWorker: async () => roleObservation(0),
      steerRole,
      roleIdlePersistence: {
        read: async () => persisted,
        write: async (state) => { persisted = structuredClone(state); },
      },
      now: () => currentNow,
    });

    await watcher.poll();
    currentNow = 10 * 60_000;
    await watcher.poll();

    expect(steerRole).toHaveBeenCalledTimes(1);
    expect(persisted).toEqual({});
  });

  it("does not escalate a second delivered steer until it is observed ineffective", async () => {
    let currentNow = 0;
    let nativeUpdatedAt = 0;
    let status: "idle" | "starting" | "active" | "stopping" | "error" = "idle";
    const alerts: string[] = [];
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<void>>().mockImplementation(async () => {
      nativeUpdatedAt = currentNow;
      status = "starting";
    });
    const watcher = createLaneWatcher({
      readRoleHolders: () => [roleHolder()],
      readRoleScopes: () => [roleScope("queue-head")],
      readWorker: async () => status === "idle"
        ? roleObservation(nativeUpdatedAt)
        : { ...roleObservation(nativeUpdatedAt), status: "active", idleSinceMs: null },
      steerRole,
      now: () => currentNow,
      onAlert: (alert) => alerts.push(alert.kind),
    });

    await watcher.poll();
    currentNow = 10 * 60_000;
    await watcher.poll();
    await watcher.poll();
    status = "active";
    await watcher.poll();
    status = "stopping";
    await watcher.poll();
    status = "error";
    await watcher.poll();
    status = "idle";
    currentNow = 20 * 60_000;
    await watcher.poll();
    await watcher.poll();
    await watcher.poll();
    currentNow = 30 * 60_000;
    await watcher.poll();
    await watcher.poll();
    await watcher.poll();
    status = "starting";
    await watcher.poll();
    status = "active";
    await watcher.poll();
    status = "stopping";
    await watcher.poll();
    status = "error";
    await watcher.poll();
    expect(steerRole).toHaveBeenCalledTimes(2);
    expect(alerts).toEqual([]);
    status = "idle";
    currentNow = 40 * 60_000;
    await watcher.poll();
    await watcher.poll();
    await watcher.poll();
    currentNow = 50 * 60_000;
    await watcher.poll();
    expect(alerts).toEqual(["wrongful_idle_fyi"]);
  });

  it("survives reload and clears the role key on queue change or active state", async () => {
    let currentNow = 0;
    let status: "idle" | "active" = "idle";
    let queueHead = "queue-head-1";
    let persisted: unknown;
    const persistence = {
      read: async () => persisted,
      write: async (state: Record<string, unknown>) => { persisted = state; },
    };
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<void>>().mockResolvedValue(undefined);
    const options = {
      readRoleHolders: () => [roleHolder()],
      readRoleScopes: () => [roleScope(status === "idle" ? queueHead : null)],
      readWorker: async () => ({ ...roleObservation(0), status, pendingExternalWait: false }),
      steerRole,
      roleIdlePersistence: persistence,
      now: () => currentNow,
    };
    const firstWatcher = createLaneWatcher(options);
    await firstWatcher.poll();
    const restartedWatcher = createLaneWatcher(options);
    await restartedWatcher.recover();
    await restartedWatcher.poll();
    currentNow = 10 * 60_000;
    await restartedWatcher.poll();
    expect(steerRole).toHaveBeenCalledTimes(1);

    queueHead = "queue-head-2";
    await restartedWatcher.poll();
    expect(steerRole).toHaveBeenCalledTimes(1);
    currentNow = 20 * 60_000;
    await restartedWatcher.poll();
    expect(steerRole).toHaveBeenCalledTimes(2);
    status = "active";
    await restartedWatcher.poll();
    status = "idle";
    currentNow = 30 * 60_000;
    await restartedWatcher.poll();
    expect(steerRole).toHaveBeenCalledTimes(2);
  });

  it("escalates once after two failed role steers", async () => {
    let currentNow = 0;
    const alerts: string[] = [];
    const succession: RoleIdleView[] = [];
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<void>>().mockRejectedValue(new Error("send failed"));
    const watcher = createLaneWatcher({
      readRoleHolders: () => [roleHolder()],
      readRoleScopes: () => [roleScope("queue-head")],
      readWorker: async () => roleObservation(0),
      steerRole,
      now: () => currentNow,
      onAlert: (alert) => alerts.push(alert.kind),
      onRoleSuccessionRequired: (role) => succession.push(role),
    });
    await watcher.poll();
    currentNow = 10 * 60_000;

    await watcher.poll();
    currentNow = 20 * 60_000;
    await watcher.poll();
    currentNow = 30 * 60_000;
    await watcher.poll();

    expect(steerRole).toHaveBeenCalledTimes(2);
    expect(alerts).toEqual(["wrongful_idle_fyi"]);
    expect(succession).toHaveLength(1);
  });

  it("keeps a wait pending through a fired-state write outage and retries exactly once", async () => {
    let persisted: unknown;
    let failWrites = false;
    let writeAttempts = 0;
    const registry = createWaitRegistry({
      read: async () => persisted,
      write: async (state) => {
        writeAttempts += 1;
        if (failWrites) throw new Error("awareness storage unavailable");
        persisted = structuredClone(state);
      },
    });
    await registry.register(registeredWait({ waiterThreadId: "director-1", sourceThreadId: "worker-source" }));
    expect(registry.state("wait-1")).toBe("pending");

    const onWaitEvent = vi.fn();
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<void>>().mockResolvedValue(undefined);
    const watcher = createLaneWatcher({
      waitRegistry: registry,
      readRoleHolders: () => [roleHolder()],
      readRoleScopes: () => [roleScope("queue-head")],
      readWorker: async () => roleObservation(0),
      steerRole,
      roleIdleThresholdMs: 0,
      onWaitEvent,
      now: () => 1,
    });

    failWrites = true;
    await watcher.observe("worker-source", "error");
    expect(writeAttempts).toBe(2);
    expect(registry.state("wait-1")).toBe("pending");
    expect(onWaitEvent).not.toHaveBeenCalled();
    expect(steerRole).not.toHaveBeenCalled();

    failWrites = false;
    await watcher.observe("worker-source", "error");
    await watcher.observe("worker-source", "error");
    expect(writeAttempts).toBe(3);
    expect(registry.state("wait-1")).toBe("fired");
    expect(onWaitEvent).toHaveBeenCalledTimes(1);
    expect(steerRole).toHaveBeenCalledTimes(1);
  });

  it("wakes the waiting role holder when a wait event fires", async () => {
    const registry = createWaitRegistry();
    await registry.register(registeredWait({ waiterThreadId: "director-1", sourceThreadId: "worker-source" }));
    expect(registry.state("wait-1")).toBe("pending");

    const onWaitEvent = vi.fn();
    const readWorker = vi.fn(async () => roleObservation(0));
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<void>>().mockResolvedValue(undefined);
    const watcher = createLaneWatcher({
      waitRegistry: registry,
      readRoleHolders: () => [roleHolder()],
      readRoleScopes: () => [roleScope("queue-head")],
      readWorker,
      steerRole,
      roleIdleThresholdMs: 0,
      onWaitEvent,
      now: () => 1,
    });

    await watcher.observe("worker-source", "error");

    expect(registry.state("wait-1")).toBe("fired");
    expect(onWaitEvent).toHaveBeenCalledTimes(1);
    expect(readWorker).toHaveBeenCalledWith("director-1");
    expect(steerRole).toHaveBeenCalledWith(expect.objectContaining({ threadId: "director-1" }));
  });

  it("polls every current canonical role seat during quiet GitHub without targeting historical holders or writing canonical rows", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE execution_attempts (project_id TEXT, assignment_id TEXT, thread_id TEXT, execution_attempt_id TEXT, origin TEXT, state TEXT, terminal_report_digest TEXT, role_id TEXT, role_generation INTEGER)");
    db.exec("CREATE TABLE role_generation_heads (project_id TEXT, role_id TEXT, current_generation INTEGER)");
    db.exec("CREATE TABLE role_generations (project_id TEXT, role_id TEXT, generation INTEGER, status TEXT, holder_execution_attempt_id TEXT)");
    db.prepare("INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("project-1", null, "director-1", "role-attempt-3", "role_holder", "done", null, "project-orchestrator", 3);
    db.prepare("INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("project-1", null, "retired-director", "role-attempt-stale", "role_holder", "done", null, "project-orchestrator", 3);
    db.prepare("INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("project-1", null, "previous-director", "role-attempt-2", "role_holder", "done", null, "project-orchestrator", 2);
    db.prepare("INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("project-1", null, "worker-role-1", "worker-role-attempt", "role_holder", "done", null, "worker", 1);
    db.prepare("INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("project-1", null, "reviewer-4", "reviewer-attempt-4", "role_holder", "done", null, "independent-reviewer", 4);
    db.prepare("INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("project-1", null, "future-seat-9", "future-seat-attempt-9", "role_holder", "done", null, "role-added-after-watcher-build", 9);
    db.prepare("INSERT INTO role_generation_heads VALUES (?, ?, ?)").run("project-1", "project-orchestrator", 3);
    db.prepare("INSERT INTO role_generations VALUES (?, ?, ?, ?, ?)").run("project-1", "project-orchestrator", 3, "active", "role-attempt-3");
    db.prepare("INSERT INTO role_generations VALUES (?, ?, ?, ?, ?)").run("project-1", "project-orchestrator", 2, "retired", "role-attempt-2");
    db.prepare("INSERT INTO role_generation_heads VALUES (?, ?, ?)").run("project-1", "worker", 1);
    db.prepare("INSERT INTO role_generations VALUES (?, ?, ?, ?, ?)").run("project-1", "worker", 1, "active", "worker-role-attempt");
    db.prepare("INSERT INTO role_generation_heads VALUES (?, ?, ?)").run("project-1", "independent-reviewer", 4);
    db.prepare("INSERT INTO role_generations VALUES (?, ?, ?, ?, ?)").run("project-1", "independent-reviewer", 4, "active", "reviewer-attempt-4");
    db.prepare("INSERT INTO role_generation_heads VALUES (?, ?, ?)").run("project-1", "role-added-after-watcher-build", 9);
    db.prepare("INSERT INTO role_generations VALUES (?, ?, ?, ?, ?)").run("project-1", "role-added-after-watcher-build", 9, "active", "future-seat-attempt-9");
    expect(readRoleHolderStates(db).map((holder) => holder.thread_id)).toEqual(["reviewer-4", "director-1", "future-seat-9", "worker-role-1"]);
    const before = {
      attempts: db.prepare("SELECT * FROM execution_attempts").all(),
      heads: db.prepare("SELECT * FROM role_generation_heads").all(),
      generations: db.prepare("SELECT * FROM role_generations").all(),
    };
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<void>>().mockResolvedValue(undefined);
    let currentNow = 0;
    const watcher = createLaneWatcher({
      readRoleHolders: () => readRoleHolderStates(db),
      readRoleScopes: () => [roleScope("queue-head")],
      readWorker: async () => roleObservation(0),
      steerRole,
      now: () => currentNow,
    });

    await watcher.poll();
    currentNow = 10 * 60_000;
    await watcher.poll();

    expect(steerRole.mock.calls.map(([role]) => role.threadId).sort()).toEqual(["director-1", "future-seat-9", "reviewer-4", "worker-role-1"]);

    expect({
      attempts: db.prepare("SELECT * FROM execution_attempts").all(),
      heads: db.prepare("SELECT * FROM role_generation_heads").all(),
      generations: db.prepare("SELECT * FROM role_generations").all(),
    }).toEqual(before);
    db.close();
  });

  it.each(["active orchestrator", "one active lane", "zero startable work"])("keeps the %s conjunct silent", async () => {
    vi.useFakeTimers();
    try {
      const wake = vi.fn(async () => true);
      const onBlind = vi.fn();
      const detector = createIdleFleetDetector({
        read: async (): Promise<IdleFleetDecision> => ({ kind: "silent" }),
        readRearmProbes: async () => [],
        wake,
        onBlind,
        debounceMs: IDLE_FLEET_DEBOUNCE_MS,
      });

      detector.arm({ projectId: "project-1", threadId: "orchestrator-1", idleEpisode: "episode-1" });
      await vi.advanceTimersByTimeAsync(IDLE_FLEET_DEBOUNCE_MS);

      expect(wake).not.toHaveBeenCalled();
      expect(onBlind).not.toHaveBeenCalled();
      detector.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an unreadable conjunct and never treats it as healthy", async () => {
    vi.useFakeTimers();
    try {
      const wake = vi.fn(async () => true);
      const onBlind = vi.fn();
      const message = "idle-fleet coverage=blind orchestrator=known activeLanes=blind startable=known reason=work-items-have-no-thread-binding:GH-300";
      const detector = createIdleFleetDetector({
        read: async (): Promise<IdleFleetDecision> => ({ kind: "blind", message }),
        readRearmProbes: async () => [],
        wake,
        onBlind,
        debounceMs: IDLE_FLEET_DEBOUNCE_MS,
      });

      detector.arm({ projectId: "project-1", threadId: "orchestrator-1", idleEpisode: "episode-1" });
      await vi.advanceTimersByTimeAsync(IDLE_FLEET_DEBOUNCE_MS);

      expect(wake).not.toHaveBeenCalled();
      expect(onBlind).toHaveBeenCalledExactlyOnceWith(message);
      detector.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("debounces, persists, and deduplicates one unchanged idle-fleet episode", async () => {
    vi.useFakeTimers();
    try {
      let persisted: unknown;
      const wake = vi.fn(async () => true);
      const role = {
        projectId: "project-1",
        roleId: "project-orchestrator",
        roleGeneration: 3,
        executionAttemptId: "attempt-3",
        threadId: "orchestrator-1",
        queueHeadId: "repo#305",
        idleAgeMs: 0,
      };
      const options = {
        read: async (): Promise<IdleFleetDecision> => ({ kind: "ready", episodeKey: "episode-1:repo#305", role, message: "wake" }),
        readRearmProbes: async () => [{ projectId: "project-1", threadId: "orchestrator-1", idleEpisode: "episode-1" }],
        wake,
        onBlind: vi.fn(),
        persistence: {
          read: async () => persisted,
          write: async (state: Record<string, string>) => { persisted = state; },
        },
        debounceMs: IDLE_FLEET_DEBOUNCE_MS,
      };
      const detector = createIdleFleetDetector(options);

      detector.arm({ projectId: "project-1", threadId: "orchestrator-1", idleEpisode: "episode-1" });
      await vi.advanceTimersByTimeAsync(IDLE_FLEET_DEBOUNCE_MS - 1);
      expect(wake).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(wake).toHaveBeenCalledTimes(1);

      detector.arm({ projectId: "project-1", threadId: "orchestrator-1", idleEpisode: "episode-1" });
      await vi.advanceTimersByTimeAsync(IDLE_FLEET_DEBOUNCE_MS);
      expect(wake).toHaveBeenCalledTimes(1);
      detector.stop();

      const restarted = createIdleFleetDetector(options);
      await restarted.rearm();
      await vi.advanceTimersByTimeAsync(IDLE_FLEET_DEBOUNCE_MS);
      expect(wake).toHaveBeenCalledTimes(1);
      restarted.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
