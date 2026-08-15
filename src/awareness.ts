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
  observe(
    threadId: string,
    status: ThreadStatus,
    pendingExternalWait?: boolean,
    archived?: boolean,
  ): Promise<void>;
  poll(): Promise<void>;
}

export interface WorkerObservation {
  status: ThreadStatus;
  pendingExternalWait: boolean;
  archived: boolean;
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
  isExternallyWaiting?: (threadId: string) => Promise<boolean>;
  readWorker?: (threadId: string) => Promise<WorkerObservation>;
  supervisorThreadId?: string;
}): LaneWatcher {
  const supervisorThreadId = options.supervisorThreadId ?? SUPERVISOR_THREAD_ID;
  const coalesced = new Set<string>();
  let queue = Promise.resolve();

  const laneKey = (lane: LaneState) => `${lane.project_id}:${lane.execution_attempt_id}`;
  const clearResolved = (lanes: LaneState[]) => {
    const unresolved = new Set(
      lanes
        .filter((lane) => OPEN_ATTEMPT_STATES.has(lane.attempt_state) && lane.terminal_report_digest === null)
        .map(laneKey),
    );
    for (const key of coalesced) {
      if (!unresolved.has(key)) coalesced.delete(key);
    }
  };

  const observeNow = async (
    threadId: string,
    status: ThreadStatus,
    pendingExternalWait?: boolean,
    archived = false,
  ): Promise<void> => {
    const allLanes = options.readLanes();
    clearResolved(allLanes);
    const candidates = allLanes.filter(
      (lane) =>
        lane.thread_id === threadId &&
        lane.thread_id !== supervisorThreadId &&
        OPEN_ATTEMPT_STATES.has(lane.attempt_state),
    );
    if (candidates.length === 0) return;

    let waiting = pendingExternalWait ?? false;
    if (!archived && status === "idle" && pendingExternalWait === undefined && options.isExternallyWaiting) {
      try {
        waiting = await options.isExternallyWaiting(threadId);
      } catch {
        // Unknown wait state is not evidence that steering is safe.
        waiting = true;
      }
    }

    if (archived || status !== "idle" || waiting) {
      for (const lane of candidates) coalesced.delete(laneKey(lane));
      return;
    }

    for (const lane of candidates) {
      const key = laneKey(lane);
      if (lane.terminal_report_digest !== null || coalesced.has(key)) continue;

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
  };

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    observe(threadId, status, pendingExternalWait, archived) {
      if (threadId === supervisorThreadId) return Promise.resolve();
      return enqueue(() => observeNow(threadId, status, pendingExternalWait, archived));
    },
    poll() {
      return enqueue(async () => {
        const lanes = options.readLanes();
        clearResolved(lanes);
        if (!options.readWorker) return;

        const workerIds = new Set(
          lanes
            .filter((lane) => OPEN_ATTEMPT_STATES.has(lane.attempt_state) && lane.thread_id)
            .map((lane) => lane.thread_id as string)
            .filter((threadId) => threadId !== supervisorThreadId),
        );
        for (const threadId of workerIds) {
          let observation: WorkerObservation;
          try {
            observation = await options.readWorker(threadId);
          } catch {
            // A failed native read cannot prove that steering is safe.
            continue;
          }
          await observeNow(
            threadId,
            observation.status,
            observation.pendingExternalWait,
            observation.archived,
          );
        }
      });
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
  observe: (threadId: string, status: ThreadStatus, archived?: boolean) => Promise<void>,
): () => void {
  try {
    return sdk.subscribe({
      event: "thread:changed",
      callback: (event) => {
        if (event.entity !== "thread" || !event.id) return;
        void sdk.threads
          .get({ threadId: event.id })
          .then((thread) => thread.archivedAt === null && thread.deletedAt === null
            ? observe(thread.id, thread.status)
            : observe(thread.id, thread.status, true))
          .catch(() => undefined);
      },
    });
  } catch {
    // Isolated SDK test hosts may omit the optional realtime stub.
    return () => undefined;
  }
}
