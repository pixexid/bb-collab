import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
  continuationModeFor,
  createContinuationLedger,
  createLaneWatcher,
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

describe("lane awareness", () => {
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
});
