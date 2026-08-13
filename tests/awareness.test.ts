import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { createLaneWatcher, readLaneStates, type LaneState, type LaneView } from "../src/awareness.js";

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
    expect(steer.mock.calls[0]?.[0].laneId).toBe("lane-1");
  });

  it("coalesces duplicate observations until the worker becomes active", async () => {
    const steer = vi.fn<(lane: LaneView) => Promise<void>>().mockResolvedValue(undefined);
    const watcher = createLaneWatcher({ readLanes: () => [lane()], steer });

    await watcher.observe("worker-1", "idle");
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
