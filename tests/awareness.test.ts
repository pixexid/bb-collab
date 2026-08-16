import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
  continuationModeFor,
  createContinuationLedger,
  createLaneWatcher,
  createWaitRegistry,
  openLaneViews,
  type OperatorWait,
  type RegisteredWait,
  readLaneStates,
  readRoleHolderStates,
  SUPERVISOR_THREAD_ID,
  type RoleHolderState,
  type RoleIdleView,
  type LaneState,
  type LaneView,
} from "../src/awareness.js";

function lane(threadId = "worker-1"): LaneState {
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

function roleObservation(idleSinceMs: number): { status: "idle"; pendingExternalWait: false; archived: false; operatorWait: null; operatorWaitKnown: true; idleSinceMs: number } {
  return { status: "idle", pendingExternalWait: false, archived: false, operatorWait: null, operatorWaitKnown: true, idleSinceMs };
}

function registeredWait(overrides: Partial<RegisteredWait> = {}): RegisteredWait {
  return {
    waitId: "wait-1",
    waiterThreadId: "worker-1",
    sourceThreadId: "source-1",
    sourceEvent: "terminal",
    deadlineAtMs: Date.now() + 60_000,
    ...overrides,
  };
}

function laneConfig(db: Database.Database, writingLaneCeiling = 3) {
  db.exec("CREATE TABLE project_config_revisions (project_id TEXT, config_revision INTEGER, canonical_config_json TEXT)");
  db.exec("CREATE TABLE project_config_heads (project_id TEXT, config_revision INTEGER)");
  db.prepare("INSERT INTO project_config_revisions VALUES (?, ?, ?)").run("project-1", 1, JSON.stringify({ extensions: { bbCollab: { writingLaneCeiling } } }));
  db.prepare("INSERT INTO project_config_heads VALUES (?, ?)").run("project-1", 1);
}

describe("lane awareness", () => {
  it("does not let an awaiting operator lane block the next startable lane", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE assignments (project_id TEXT, assignment_id TEXT, lane_id TEXT, assignment_kind TEXT, work_item_id TEXT, created_at_ms INTEGER)");
    db.exec("CREATE TABLE execution_attempts (project_id TEXT, assignment_id TEXT, thread_id TEXT, execution_attempt_id TEXT, origin TEXT, state TEXT, terminal_report_digest TEXT)");
    laneConfig(db, 2);
    db.prepare("INSERT INTO assignments VALUES (?, ?, ?, ?, ?, ?)").run("project-1", "deferred", "lane-deferred", "write", "work-deferred", 1);
    db.prepare("INSERT INTO assignments VALUES (?, ?, ?, ?, ?, ?)").run("project-1", "ready", "lane-ready", "write", "work-ready", 2);
    db.prepare("INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?)").run("project-1", "deferred", "worker-deferred", "attempt-deferred", "assignment", "prepared", null);
    db.prepare("INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?)").run("project-1", "ready", "worker-ready", "attempt-ready", "assignment", "prepared", null);

    const views = openLaneViews(db, 1_000, new Map<string, OperatorWait>([
      ["worker-deferred", { reason: "awaiting_operator", createdAtMs: 900 }],
    ]));

    expect(views[0]).toMatchObject({
      laneId: "lane-deferred",
      queueState: "deferred",
      queueBlocked: false,
      nextStartable: false,
      deferredReason: "awaiting_operator",
      deferredAtMs: 900,
      deferredAgeMs: 100,
    });
    expect(views[1]).toMatchObject({ laneId: "lane-ready", queueBlocked: false, nextStartable: true });
    db.prepare("UPDATE project_config_revisions SET canonical_config_json = ?").run(JSON.stringify({ extensions: { bbCollab: { writingLaneCeiling: 1 } } }));
    expect(openLaneViews(db, 1_000, new Map<string, OperatorWait>([
      ["worker-deferred", { reason: "awaiting_operator", createdAtMs: 900 }],
    ]))[1]).toMatchObject({ laneId: "lane-ready", queueBlocked: true, nextStartable: false });
    db.close();
  });

  it("marks three writing lanes startable, blocks the fourth, and leaves read-only work outside the cap", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE assignments (project_id TEXT, assignment_id TEXT, lane_id TEXT, assignment_kind TEXT, work_item_id TEXT, created_at_ms INTEGER)");
    db.exec("CREATE TABLE execution_attempts (project_id TEXT, assignment_id TEXT, thread_id TEXT, execution_attempt_id TEXT, origin TEXT, state TEXT, terminal_report_digest TEXT)");
    db.exec("CREATE TABLE tasks (id TEXT); CREATE TABLE threads (id TEXT)");
    db.prepare("INSERT INTO tasks VALUES ('raw-task-1'), ('raw-task-2'), ('raw-task-3'), ('raw-task-4')").run();
    db.prepare("INSERT INTO threads VALUES ('raw-thread-1'), ('raw-thread-2'), ('raw-thread-3'), ('raw-thread-4')").run();
    laneConfig(db);
    const add = (assignmentId: string, kind: string, state: string, createdAtMs: number) => {
      db.prepare("INSERT INTO assignments VALUES (?, ?, ?, ?, ?, ?)").run("project-1", assignmentId, `lane-${assignmentId}`, kind, `work-${assignmentId}`, createdAtMs);
      db.prepare("INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?)").run("project-1", assignmentId, `thread-${assignmentId}`, `attempt-${assignmentId}`, "assignment", state, null);
    };
    add("write-1", "write", "prepared", 1);
    add("write-2", "write", "prepared", 2);
    add("write-3", "write", "prepared", 3);
    add("write-4", "write", "prepared", 4);
    add("review", "review", "prepared", 5);

    expect(openLaneViews(db).map((view) => [view.assignmentId, view.nextStartable, view.queueBlocked])).toEqual([
      ["write-1", true, false],
      ["write-2", true, false],
      ["write-3", true, false],
      ["write-4", false, true],
      ["review", true, false],
    ]);
    db.close();
  });

  it("keeps a full writing cap from blocking a read-only lane and respects a lower dial", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE assignments (project_id TEXT, assignment_id TEXT, lane_id TEXT, assignment_kind TEXT, work_item_id TEXT, created_at_ms INTEGER)");
    db.exec("CREATE TABLE execution_attempts (project_id TEXT, assignment_id TEXT, thread_id TEXT, execution_attempt_id TEXT, origin TEXT, state TEXT, terminal_report_digest TEXT)");
    laneConfig(db, 1);
    const add = (assignmentId: string, kind: string, state: string, createdAtMs: number) => {
      db.prepare("INSERT INTO assignments VALUES (?, ?, ?, ?, ?, ?)").run("project-1", assignmentId, `lane-${assignmentId}`, kind, `work-${assignmentId}`, createdAtMs);
      db.prepare("INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?)").run("project-1", assignmentId, `thread-${assignmentId}`, `attempt-${assignmentId}`, "assignment", state, null);
    };
    add("running", "write", "running", 1);
    add("queued-write", "write", "prepared", 2);
    add("queued-review", "review", "prepared", 3);

    expect(openLaneViews(db).map((view) => [view.assignmentId, view.nextStartable, view.queueBlocked])).toEqual([
      ["running", false, false],
      ["queued-write", false, true],
      ["queued-review", true, false],
    ]);
    db.close();
  });

  it("detects only a startable, non-deferred queue for a role", async () => {
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<void>>().mockResolvedValue(undefined);
    let scopes = [roleScope(null, "awaiting_operator")];
    let currentNow = 0;
    const watcher = createLaneWatcher({
      readLanes: () => [],
      steer: vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined),
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

  it.each([
    ["matching", "project-1", "thr_b94i3csnme"],
    ["foreign", "project-2", "director-1"],
  ])("selects the %s role observation target", async (_name, dispatcherProjectId, targetThreadId) => {
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<void>>().mockResolvedValue(undefined);
    let currentNow = 0;
    const watcher = createLaneWatcher({
      readLanes: () => [],
      steer: vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined),
      readRoleHolders: () => [roleHolder()],
      readRoleScopes: () => [roleScope("queue-head")],
      readDispatcherProjectIdentity: async () => dispatcherProjectId,
      readWorker: async (threadId) => ({ ...roleObservation(0), status: threadId === targetThreadId ? "idle" : "active" }),
      steerRole,
      now: () => currentNow,
    });

    await watcher.poll();
    currentNow = 10 * 60_000;
    await watcher.poll();

    expect(steerRole).toHaveBeenCalledWith(expect.objectContaining({ threadId: targetThreadId }));
  });

  it("suppresses role observation when native dispatcher identity is ambiguous", async () => {
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<void>>().mockResolvedValue(undefined);
    const watcher = createLaneWatcher({
      readLanes: () => [],
      steer: vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined),
      readRoleHolders: () => [roleHolder()],
      readRoleScopes: () => [roleScope("queue-head")],
      readDispatcherProjectIdentity: async () => null,
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
      readLanes: () => [],
      steer: vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined),
      readRoleHolders: () => [roleHolder()],
      readRoleScopes: () => [],
      readDispatcherProjectIdentity: async () => "project-1",
      readWorker: async () => roleObservation(0),
      steerRole,
      now: () => 10 * 60_000,
    });

    await watcher.poll();

    expect(steerRole).not.toHaveBeenCalled();
  });

  it("observes the dispatcher target from a supervisor event", async () => {
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<void>>().mockResolvedValue(undefined);
    let currentNow = 0;
    const watcher = createLaneWatcher({
      readLanes: () => [],
      steer: vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined),
      readRoleHolders: () => [roleHolder()],
      readRoleScopes: () => [roleScope("queue-head")],
      readDispatcherProjectIdentity: async () => "project-1",
      readWorker: async (threadId) => ({ ...roleObservation(0), status: threadId === SUPERVISOR_THREAD_ID ? "idle" : "active" }),
      steerRole,
      now: () => currentNow,
    });

    await watcher.observe(SUPERVISOR_THREAD_ID, "idle");
    currentNow = 10 * 60_000;
    await watcher.observe(SUPERVISOR_THREAD_ID, "idle");

    expect(steerRole).toHaveBeenCalledWith(expect.objectContaining({ threadId: SUPERVISOR_THREAD_ID }));
  });

  it("waits for the exact ten-minute wrongful-idle threshold", async () => {
    let currentNow = 0;
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<void>>().mockResolvedValue(undefined);
    const watcher = createLaneWatcher({
      readLanes: () => [],
      steer: vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined),
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
      readLanes: () => [],
      steer: vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined),
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
      readLanes: () => [],
      steer: vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined),
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
      readLanes: () => [],
      steer: vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined),
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
      readLanes: () => [],
      steer: vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined),
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

  it("steers on a synthetic idle transition", async () => {
    const steer = vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined);
    const watcher = createLaneWatcher({ readLanes: () => [lane()], steer });

    await watcher.observe("worker-1", "idle");

    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer.mock.calls[0]?.[0]).toMatchObject({ laneId: "lane-1", threadId: "worker-1" });
  });

  it("coalesces duplicate observations until the worker becomes active", async () => {
    const steer = vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined);
    const watcher = createLaneWatcher({
      readLanes: () => [lane()],
      steer,
      readWorker: vi.fn().mockResolvedValue({ status: "idle", pendingExternalWait: false, archived: false }),
    });

    await watcher.observe("worker-1", "idle");
    await watcher.poll();
    await watcher.observe("worker-1", "idle");
    await watcher.observe("worker-1", "active");
    await watcher.observe("worker-1", "idle");

    expect(steer).toHaveBeenCalledTimes(2);
  });

  it("allows only a registered wait to explain an idle worker", async () => {
    const registered = createWaitRegistry();
    await registered.register(registeredWait());
    const readWorker = async (threadId: string) => threadId === "source-1"
      ? { status: "active" as const, pendingExternalWait: false, archived: false }
      : { status: "idle" as const, pendingExternalWait: false, archived: false };
    const registeredSteer = vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined);
    await createLaneWatcher({ readLanes: () => [lane()], steer: registeredSteer, waitRegistry: registered, readWorker }).observe("worker-1", "idle");
    expect(registeredSteer).not.toHaveBeenCalled();

    const unregisteredSteer = vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined);
    await createLaneWatcher({ readLanes: () => [lane()], steer: unregisteredSteer, readWorker }).observe("worker-1", "idle");
    expect(unregisteredSteer).toHaveBeenCalledTimes(1);
  });

  it("refuses deadline-less waits and accepts exact duplicate registration only", async () => {
    const registry = createWaitRegistry();
    await expect(registry.register({ ...registeredWait(), deadlineAtMs: undefined } as unknown as RegisteredWait)).rejects.toThrow("deadline");
    await registry.register(registeredWait());
    await expect(registry.register(registeredWait())).resolves.toBeUndefined();
    await expect(registry.register(registeredWait({ sourceThreadId: "different-source" }))).rejects.toThrow("conflicting");
  });

  it("fails closed when a registered wait source is missing or unreadable", async () => {
    const registry = createWaitRegistry();
    await registry.register(registeredWait({ sourceThreadId: "missing" }));
    const steer = vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined);
    const watcher = createLaneWatcher({
      readLanes: () => [lane()],
      steer,
      waitRegistry: registry,
      readWorker: async (threadId) => {
        if (threadId === "missing") throw new Error("thread unknown");
        return { status: "idle", pendingExternalWait: false, archived: false };
      },
    });

    await watcher.observe("worker-1", "idle");
    expect(steer).not.toHaveBeenCalled();
  });

  it("cascades known terminal and failure source events to waiters", async () => {
    const registry = createWaitRegistry();
    await registry.register(registeredWait({ waitId: "terminal-wait", sourceThreadId: "source-terminal" }));
    await registry.register(registeredWait({ waitId: "failure-wait", waiterThreadId: "worker-2", sourceThreadId: "source-failure", sourceEvent: "failure" }));
    const events: string[] = [];
    const steered: string[] = [];
    const lanes = [lane(), { ...lane("worker-2"), assignment_id: "assignment-2", lane_id: "lane-2", execution_attempt_id: "attempt-2" }, { ...lane("source-terminal"), terminal_report_digest: "done" }];
    const watcher = createLaneWatcher({
      readLanes: () => lanes,
      steer: vi.fn(async (view: LaneView) => { steered.push(view.threadId ?? ""); }),
      waitRegistry: registry,
      readWorker: async (threadId) => ({ status: threadId === "source-failure" ? "error" as const : "idle" as const, pendingExternalWait: false, archived: false }),
      onWaitEvent: (event) => { events.push(`${event.waitId}:${event.reason}`); },
    });

    await watcher.observe("worker-1", "idle");

    expect(steered.sort()).toEqual(["worker-1", "worker-2"]);
    expect(events.sort()).toEqual(["failure-wait:source_failure", "terminal-wait:source_terminal"]);
  });

  it("fires an expired wait immediately and terminally deduplicates replay", async () => {
    const registry = createWaitRegistry();
    await registry.register(registeredWait({ deadlineAtMs: 100 }));
    const events: string[] = [];
    const steer = vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined);
    const watcher = createLaneWatcher({
      readLanes: () => [lane()],
      steer,
      waitRegistry: registry,
      readWorker: async () => ({ status: "active", pendingExternalWait: false, archived: false }),
      now: () => 100,
      onWaitEvent: (event) => { events.push(event.waitId); },
    });

    await watcher.observe("worker-1", "idle");
    await watcher.observe("worker-1", "idle");

    expect(steer).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["wait-1"]);
  });

  it("does not self-wake the supervisor", async () => {
    const steer = vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined);
    const watcher = createLaneWatcher({ readLanes: () => [lane("thr_b94i3csnme")], steer });

    await watcher.observe("thr_b94i3csnme", "idle");

    expect(steer).not.toHaveBeenCalled();
  });

  it("self-watches the director once when its registered source completes", async () => {
    const registry = createWaitRegistry();
    await registry.register(registeredWait({ waiterThreadId: SUPERVISOR_THREAD_ID, sourceThreadId: "worker-source" }));
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<void>>().mockResolvedValue(undefined);
    const watcher = createLaneWatcher({
      readLanes: () => [],
      steer: vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined),
      waitRegistry: registry,
      readRoleHolders: () => [roleHolder()],
      readRoleScopes: () => [roleScope("queue-head")],
      readDispatcherProjectIdentity: async () => "project-1",
      readWorker: async (threadId) => threadId === "worker-source"
        ? { status: "error" as const, pendingExternalWait: false, archived: false }
        : roleObservation(0),
      steerRole,
      roleIdleThresholdMs: 0,
    });

    await watcher.observe("worker-source", "error");
    await watcher.observe("worker-source", "error");

    expect(steerRole).toHaveBeenCalledTimes(1);
  });

  it("keeps the director covered: prose-only idle work is not a wait", async () => {
    const steerRole = vi.fn<(role: RoleIdleView) => Promise<void>>().mockResolvedValue(undefined);
    const watcher = createLaneWatcher({
      readLanes: () => [],
      steer: vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined),
      readRoleHolders: () => [roleHolder()],
      readRoleScopes: () => [roleScope("queue-head")],
      readWorker: async () => roleObservation(0),
      steerRole,
      roleIdleThresholdMs: 0,
      now: () => 1,
    });

    await watcher.poll();

    expect(steerRole).toHaveBeenCalledTimes(1);
  });

  it("stays silent for a genuine pending external wait", async () => {
    const steer = vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined);
    const watcher = createLaneWatcher({
      readLanes: () => [lane()],
      steer,
      isExternallyWaiting: vi.fn().mockResolvedValue(true),
    });

    await watcher.observe("worker-1", "idle");
    expect(steer).not.toHaveBeenCalled();
  });

  it("resumes the same lane after its exact operator wait resolves", async () => {
    const steer = vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined);
    let operatorWait: OperatorWait | null = { reason: "awaiting_operator", createdAtMs: Date.now() };
    const watcher = createLaneWatcher({
      readLanes: () => [lane()],
      steer,
      readOperatorWait: async () => operatorWait,
    });

    await watcher.observe("worker-1", "idle");
    expect(steer).not.toHaveBeenCalled();
    operatorWait = null;
    await watcher.observe("worker-1", "idle");

    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer.mock.calls[0]?.[0]).toMatchObject({ laneId: "lane-1", assignmentId: "assignment-1", executionAttemptId: "attempt-1" });
  });

  it("fires one persisted operator-wait FYI across polls and restart", async () => {
    let persisted: unknown;
    const persistence = {
      read: async () => persisted,
      write: async (state: Record<string, true>) => { persisted = state; },
    };
    const operatorWait: OperatorWait = { reason: "awaiting_operator", createdAtMs: 0 };
    const alerts: string[] = [];
    const options = {
      readLanes: () => [lane()],
      steer: vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined),
      readOperatorWait: async () => operatorWait,
      operatorWaitAlertPersistence: persistence,
      operatorWaitFyiThresholdMs: 0,
      onAlert: (alert: { kind: string }) => alerts.push(alert.kind),
    };
    const watcher = createLaneWatcher(options);

    await watcher.observe("worker-1", "idle");
    await watcher.observe("worker-1", "idle");
    const restartedWatcher = createLaneWatcher({ ...options, onAlert: (alert) => alerts.push(alert.kind) });
    await restartedWatcher.recover();
    await restartedWatcher.observe("worker-1", "idle");

    expect(alerts).toEqual(["operator_wait_fyi"]);
  });

  it("fails closed when the operator state cannot be read", async () => {
    const steer = vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined);
    const watcher = createLaneWatcher({
      readLanes: () => [lane()],
      steer,
      readOperatorWait: async () => { throw new Error("unknown interaction state"); },
      isExternallyWaiting: async () => { throw new Error("unknown interaction state"); },
    });

    await watcher.observe("worker-1", "idle");

    expect(steer).not.toHaveBeenCalled();
  });

  it("clears an anomaly when the lane becomes terminal or archived", async () => {
    const steer = vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined);
    let current = lane();
    const watcher = createLaneWatcher({ readLanes: () => [current], steer });

    await watcher.observe("worker-1", "idle");
    current = { ...current, terminal_report_digest: "terminal" };
    await watcher.observe("worker-1", "idle");
    current = { ...current, terminal_report_digest: null };
    await watcher.observe("worker-1", "idle");
    await watcher.observe("worker-1", "idle", false, true);

    expect(steer).toHaveBeenCalledTimes(2);
  });

  it("polls worker state through the native read seam", async () => {
    const steer = vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined);
    const watcher = createLaneWatcher({
      readLanes: () => [lane()],
      steer,
      readWorker: vi.fn().mockResolvedValue({ status: "idle", pendingExternalWait: false, archived: false }),
    });

    await watcher.poll();

    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer.mock.calls[0]?.[0].threadId).toBe("worker-1");
  });

  it("uses automatic, approval, and tracking modes by lane kind", async () => {
    expect(continuationModeFor("write")).toBe("automatic");
    expect(continuationModeFor("review")).toBe("approval");
    expect(continuationModeFor("probe")).toBe("tracking");

    let current = lane();
    const steer = vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined);
    const alerts: string[] = [];
    const watcher = createLaneWatcher({
      readLanes: () => [current],
      steer,
      onAlert: (alert) => alerts.push(alert.kind),
    });

    current = { ...current, assignment_kind: "review" };
    await watcher.observe("worker-1", "idle");
    current = { ...current, assignment_kind: "probe" };
    await watcher.observe("worker-1", "active");
    await watcher.observe("worker-1", "idle");

    expect(steer).not.toHaveBeenCalled();
    expect(alerts).toEqual(["approval_required"]);
  });

  it("pauses and alerts at the per-lane continuation limit", async () => {
    const steer = vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined);
    const alerts: string[] = [];
    const watcher = createLaneWatcher({
      readLanes: () => [lane()],
      steer,
      maxContinuations: 1,
      onAlert: (alert) => alerts.push(alert.kind),
    });

    await watcher.observe("worker-1", "idle");
    await watcher.observe("worker-1", "active");
    await watcher.observe("worker-1", "idle");

    expect(steer).toHaveBeenCalledTimes(1);
    expect(alerts).toEqual(["limit_reached"]);
  });

  it("recovers a claimed delivery as paused and cannot double-fire after restart", async () => {
    let persisted: unknown;
    const persistence = {
      read: async () => persisted,
      write: async (state: Record<string, unknown>) => { persisted = state; },
    };
    let release!: () => void;
    const firstSteer = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const firstWatcher = createLaneWatcher({
      readLanes: () => [lane()],
      steer: firstSteer,
      continuationLedger: createContinuationLedger(persistence),
    });

    const first = firstWatcher.observe("worker-1", "idle");
    await vi.waitFor(() => expect(firstSteer).toHaveBeenCalledTimes(1));

    const alerts: string[] = [];
    const secondSteer = vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined);
    const restartedWatcher = createLaneWatcher({
      readLanes: () => [lane()],
      steer: secondSteer,
      continuationLedger: createContinuationLedger(persistence),
      onAlert: (alert) => alerts.push(alert.kind),
    });
    await restartedWatcher.recover();
    await restartedWatcher.observe("worker-1", "idle");

    expect(secondSteer).not.toHaveBeenCalled();
    expect(alerts).toEqual(["restart_review"]);
    release();
    await first;
  });

  it("keeps the read seam SQLite-backed", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE assignments (project_id TEXT, assignment_id TEXT, lane_id TEXT, assignment_kind TEXT, work_item_id TEXT, created_at_ms INTEGER)");
    db.exec("CREATE TABLE execution_attempts (project_id TEXT, assignment_id TEXT, thread_id TEXT, execution_attempt_id TEXT, origin TEXT, state TEXT, terminal_report_digest TEXT)");
    db.prepare("INSERT INTO assignments VALUES (?, ?, ?, ?, ?, ?)").run("project-1", "assignment-1", "lane-1", "write", "work-1", 1);
    db.prepare("INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?)").run("project-1", "assignment-1", "worker-1", "attempt-1", "assignment", "running", null);
    expect(readLaneStates(db)).toEqual([lane()]);
    db.close();
  });

  it("does not mutate canonical lane rows while observing", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE assignments (project_id TEXT, assignment_id TEXT, lane_id TEXT, assignment_kind TEXT, work_item_id TEXT, created_at_ms INTEGER)");
    db.exec("CREATE TABLE execution_attempts (project_id TEXT, assignment_id TEXT, thread_id TEXT, execution_attempt_id TEXT, origin TEXT, state TEXT, terminal_report_digest TEXT)");
    db.prepare("INSERT INTO assignments VALUES (?, ?, ?, ?, ?, ?)").run("project-1", "assignment-1", "lane-1", "write", "work-1", 1);
    db.prepare("INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?)").run("project-1", "assignment-1", "worker-1", "attempt-1", "assignment", "prepared", null);
    const before = { assignments: db.prepare("SELECT * FROM assignments").all(), attempts: db.prepare("SELECT * FROM execution_attempts").all() };
    const waitRegistry = createWaitRegistry();
    await waitRegistry.register(registeredWait({ sourceThreadId: "source-1" }));
    const watcher = createLaneWatcher({
      readLanes: () => readLaneStates(db),
      steer: vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined),
      waitRegistry,
      readWorker: async () => ({ status: "active" as const, pendingExternalWait: false, archived: false }),
      readOperatorWait: async () => ({ reason: "awaiting_operator", createdAtMs: 0 }),
      operatorWaitFyiThresholdMs: 0,
    });

    await watcher.observe("worker-1", "idle");

    expect({ assignments: db.prepare("SELECT * FROM assignments").all(), attempts: db.prepare("SELECT * FROM execution_attempts").all() }).toEqual(before);
    db.close();
  });

  it("does not write canonical role or lane rows while observing", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE assignments (project_id TEXT, assignment_id TEXT, lane_id TEXT, assignment_kind TEXT, work_item_id TEXT, created_at_ms INTEGER)");
    db.exec("CREATE TABLE execution_attempts (project_id TEXT, assignment_id TEXT, thread_id TEXT, execution_attempt_id TEXT, origin TEXT, state TEXT, terminal_report_digest TEXT, role_id TEXT, role_generation INTEGER)");
    db.exec("CREATE TABLE role_generation_heads (project_id TEXT, role_id TEXT, current_generation INTEGER)");
    db.exec("CREATE TABLE role_generations (project_id TEXT, role_id TEXT, generation INTEGER, status TEXT)");
    db.prepare("INSERT INTO assignments VALUES (?, ?, ?, ?, ?, ?)").run("project-1", "assignment-1", "lane-1", "write", "work-1", 1);
    db.prepare("INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("project-1", null, "director-1", "role-attempt-3", "role_holder", "done", null, "project-orchestrator", 3);
    db.prepare("INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("project-1", null, "worker-role-1", "worker-role-attempt", "role_holder", "done", null, "worker", 1);
    db.prepare("INSERT INTO execution_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("project-1", "assignment-1", "worker-1", "attempt-1", "assignment", "prepared", null, "worker", 1);
    db.prepare("INSERT INTO role_generation_heads VALUES (?, ?, ?)").run("project-1", "project-orchestrator", 3);
    db.prepare("INSERT INTO role_generations VALUES (?, ?, ?, ?)").run("project-1", "project-orchestrator", 3, "active");
    db.prepare("INSERT INTO role_generation_heads VALUES (?, ?, ?)").run("project-1", "worker", 1);
    db.prepare("INSERT INTO role_generations VALUES (?, ?, ?, ?)").run("project-1", "worker", 1, "active");
    expect(readRoleHolderStates(db)).toHaveLength(1);
    const before = {
      assignments: db.prepare("SELECT * FROM assignments").all(),
      attempts: db.prepare("SELECT * FROM execution_attempts").all(),
      heads: db.prepare("SELECT * FROM role_generation_heads").all(),
      generations: db.prepare("SELECT * FROM role_generations").all(),
    };
    const watcher = createLaneWatcher({
      readLanes: () => readLaneStates(db),
      steer: vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined),
      readRoleHolders: () => readRoleHolderStates(db),
      readRoleScopes: () => [roleScope("queue-head")],
      readWorker: async () => roleObservation(0),
      steerRole: vi.fn<(role: RoleIdleView) => Promise<void>>().mockResolvedValue(undefined),
      now: () => 10 * 60_000,
    });

    await watcher.poll();

    expect({
      assignments: db.prepare("SELECT * FROM assignments").all(),
      attempts: db.prepare("SELECT * FROM execution_attempts").all(),
      heads: db.prepare("SELECT * FROM role_generation_heads").all(),
      generations: db.prepare("SELECT * FROM role_generations").all(),
    }).toEqual(before);
    db.close();
  });
});
