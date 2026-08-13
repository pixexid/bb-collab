import type { BbPluginApi, PluginThreadEventPayloads } from "@bb/plugin-sdk";
import type { SqliteDatabase } from "./foundation.js";

export const SUPERVISOR_THREAD_ID = "thr_b94i3csnme";

const OPEN_ATTEMPT_STATES = new Set([
  "prepared",
  "armed",
  "content_delivered",
  "running",
  "dispatch_unknown",
]);

type ThreadStatus = PluginThreadEventPayloads["thread.active"]["thread"]["status"];

export interface LaneState {
  project_id: string;
  assignment_id: string;
  lane_id: string;
  assignment_kind: "write" | "review" | "probe";
  work_item_id: string;
  thread_id: string | null;
  execution_attempt_id: string;
  attempt_state: string;
  terminal_report_digest: string | null;
  created_at_ms: number;
}

export interface LaneView {
  projectId: string;
  laneId: string;
  assignmentId: string;
  assignmentKind: LaneState["assignment_kind"];
  workItemId: string;
  threadId: string | null;
  executionAttemptId: string;
  attemptState: string;
  workerStatus: ThreadStatus | null;
  waitingOn: string | null;
  ageMs: number;
  tone: "default" | "running" | "success" | "error";
}

export interface LaneWatcher {
  observe(threadId: string, status: ThreadStatus): Promise<void>;
}

export function readLaneStates(db: SqliteDatabase): LaneState[] {
  return db
    .prepare(
      `SELECT assignments.project_id, assignments.assignment_id, assignments.lane_id,
              assignments.assignment_kind, assignments.work_item_id,
              execution_attempts.thread_id, execution_attempts.execution_attempt_id,
              execution_attempts.state AS attempt_state,
              execution_attempts.terminal_report_digest,
              assignments.created_at_ms
       FROM assignments
       JOIN execution_attempts
         ON execution_attempts.project_id = assignments.project_id
        AND execution_attempts.assignment_id = assignments.assignment_id
       WHERE execution_attempts.origin = 'assignment'
       ORDER BY assignments.created_at_ms, assignments.assignment_id`,
    )
    .all() as LaneState[];
}

export function openLaneViews(db: SqliteDatabase, now = Date.now()): LaneView[] {
  return readLaneStates(db)
    .filter((lane) => OPEN_ATTEMPT_STATES.has(lane.attempt_state))
    .map((lane) => ({
      projectId: lane.project_id,
      laneId: lane.lane_id,
      assignmentId: lane.assignment_id,
      assignmentKind: lane.assignment_kind,
      workItemId: lane.work_item_id,
      threadId: lane.thread_id,
      executionAttemptId: lane.execution_attempt_id,
      attemptState: lane.attempt_state,
      workerStatus: null,
      waitingOn: lane.terminal_report_digest === null ? "terminal receipt" : null,
      ageMs: Math.max(0, now - lane.created_at_ms),
      tone: lane.attempt_state === "running" ? "running" : "default",
    }));
}

export function createLaneWatcher(options: {
  readLanes: () => LaneState[];
  steer: (lane: LaneView) => Promise<void>;
  supervisorThreadId?: string;
}): LaneWatcher {
  const supervisorThreadId = options.supervisorThreadId ?? SUPERVISOR_THREAD_ID;
  const coalesced = new Set<string>();

  return {
    async observe(threadId, status) {
      if (threadId === supervisorThreadId) return;

      const lanes = options.readLanes().filter(
        (lane) =>
          lane.thread_id === threadId && OPEN_ATTEMPT_STATES.has(lane.attempt_state),
      );
      for (const lane of lanes) {
        const key = `${lane.project_id}:${lane.execution_attempt_id}`;
        const anomaly = status === "idle" && lane.terminal_report_digest === null;
        if (!anomaly) {
          coalesced.delete(key);
          continue;
        }
        if (coalesced.has(key)) continue;

        coalesced.add(key);
        try {
          await options.steer({
            projectId: lane.project_id,
            laneId: lane.lane_id,
            assignmentId: lane.assignment_id,
            assignmentKind: lane.assignment_kind,
            workItemId: lane.work_item_id,
            threadId: lane.thread_id,
            executionAttemptId: lane.execution_attempt_id,
            attemptState: lane.attempt_state,
            workerStatus: status,
            waitingOn: "terminal receipt",
            ageMs: 0,
            tone: "error",
          });
        } catch (error) {
          coalesced.delete(key);
          throw error;
        }
      }
    },
  };
}

export function threadEventStatus(
  payload:
    | PluginThreadEventPayloads["thread.active"]
    | PluginThreadEventPayloads["thread.idle"]
    | PluginThreadEventPayloads["thread.failed"],
): { id: string; status: ThreadStatus } {
  return {
    id: payload.thread.id,
    status: payload.thread.status,
  };
}

export function subscribeToThreadChanges(
  sdk: Pick<BbPluginApi["sdk"], "subscribe" | "threads">,
  observe: (threadId: string, status: ThreadStatus) => Promise<void>,
): () => void {
  try {
    return sdk.subscribe({
      event: "thread:changed",
      callback: (event) => {
        if (event.entity !== "thread" || !event.id) return;
        void sdk.threads
          .get({ threadId: event.id })
          .then((thread) => observe(thread.id, thread.status))
          .catch(() => undefined);
      },
    });
  } catch {
    // Isolated SDK test hosts may omit the optional realtime stub.
    return () => undefined;
  }
}
