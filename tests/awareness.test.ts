import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
  continuationModeFor,
  createContinuationLedger,
  createLaneWatcher,
  openLaneViews,
  type OperatorWait,
  readLaneStates,
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
    laneConfig(db);
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
    db.close();
  });

  it("marks three writing lanes startable, blocks the fourth, and leaves read-only work outside the cap", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE assignments (project_id TEXT, assignment_id TEXT, lane_id TEXT, assignment_kind TEXT, work_item_id TEXT, created_at_ms INTEGER)");
    db.exec("CREATE TABLE execution_attempts (project_id TEXT, assignment_id TEXT, thread_id TEXT, execution_attempt_id TEXT, origin TEXT, state TEXT, terminal_report_digest TEXT)");
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

  it("ignores raw task and thread rows when deriving canonical lane capacity", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE assignments (project_id TEXT, assignment_id TEXT, lane_id TEXT, assignment_kind TEXT, work_item_id TEXT, created_at_ms INTEGER)");
    db.exec("CREATE TABLE execution_attempts (project_id TEXT, assignment_id TEXT, thread_id TEXT, execution_attempt_id TEXT, origin TEXT, state TEXT, terminal_report_digest TEXT)");
    db.exec("CREATE TABLE tasks (id TEXT); CREATE TABLE threads (id TEXT)");
    db.prepare("INSERT INTO tasks VALUES ('raw-task-1'), ('raw-task-2'), ('raw-task-3'), ('raw-task-4')").run();
    db.prepare("INSERT INTO threads VALUES ('raw-thread-1'), ('raw-thread-2'), ('raw-thread-3'), ('raw-thread-4')").run();
    laneConfig(db);
    expect(openLaneViews(db)).toEqual([]);
    db.close();
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

  it("does not self-wake the supervisor", async () => {
    const steer = vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined);
    const watcher = createLaneWatcher({ readLanes: () => [lane("thr_b94i3csnme")], steer });

    await watcher.observe("thr_b94i3csnme", "idle");

    expect(steer).not.toHaveBeenCalled();
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
    const watcher = createLaneWatcher({
      readLanes: () => readLaneStates(db),
      steer: vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined),
      readOperatorWait: async () => ({ reason: "awaiting_operator", createdAtMs: 0 }),
      operatorWaitFyiThresholdMs: 0,
    });

    await watcher.observe("worker-1", "idle");

    expect({ assignments: db.prepare("SELECT * FROM assignments").all(), attempts: db.prepare("SELECT * FROM execution_attempts").all() }).toEqual(before);
    db.close();
  });
});
