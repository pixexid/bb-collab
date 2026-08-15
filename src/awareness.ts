import type { BbPluginApi, PluginThreadEventPayloads } from "@bb/plugin-sdk";
import type { SqliteDatabase } from "./foundation.js";

export const SUPERVISOR_THREAD_ID = "thr_b94i3csnme";
export const DEFAULT_MAX_CONTINUATIONS = 3;

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

export type ContinuationMode = "automatic" | "approval" | "tracking";

type ContinuationStatus = "ready" | "claimed" | "paused" | "limit_reached";

interface ContinuationRecord {
  mode: "automatic";
  status: ContinuationStatus;
  count: number;
  max: number;
  claimId: string | null;
}

export interface ContinuationPersistence {
  read(): Promise<unknown>;
  write(state: Record<string, ContinuationRecord>): Promise<void>;
}

export interface ContinuationClaim {
  claimId: string;
  count: number;
  max: number;
}

export type ContinuationClaimResult =
  | { claim: ContinuationClaim }
  | { claim: null; reason: "claimed" | "paused" | "limit_reached" };

export interface ContinuationLedger {
  recover(): Promise<void>;
  claim(key: string, max: number): Promise<ContinuationClaimResult>;
  complete(key: string, claimId: string): Promise<void>;
  resume(key: string, resetCount?: boolean): Promise<void>;
}

export type LaneWatcherAlert = {
  kind: "approval_required" | "limit_reached" | "restart_review" | "delivery_uncertain";
  lane: LaneView;
  count: number;
  max: number;
};

function continuationState(input: unknown): Record<string, ContinuationRecord> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const state: Record<string, ContinuationRecord> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid continuation state");
    const candidate = value as Record<string, unknown>;
    if (
      candidate.mode !== "automatic" ||
      !["ready", "claimed", "paused", "limit_reached"].includes(candidate.status as string) ||
      !Number.isInteger(candidate.count) || (candidate.count as number) < 0 ||
      !Number.isInteger(candidate.max) || (candidate.max as number) < 1 ||
      !(candidate.claimId === null || typeof candidate.claimId === "string")
    ) throw new Error("invalid continuation state");
    state[key] = {
      mode: "automatic",
      status: candidate.status as ContinuationStatus,
      count: candidate.count as number,
      max: candidate.max as number,
      claimId: candidate.claimId as string | null,
    };
  }
  return state;
}

export function createContinuationLedger(persistence?: ContinuationPersistence): ContinuationLedger {
  let state: Record<string, ContinuationRecord> = {};
  let loaded = false;
  let queue = Promise.resolve();

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const load = async () => {
    if (loaded) return;
    state = continuationState(persistence ? await persistence.read() : null);
    loaded = true;
  };
  const save = () => persistence?.write(structuredClone(state));

  return {
    recover() {
      return enqueue(async () => {
        await load();
        let changed = false;
        for (const record of Object.values(state)) {
          if (record.status !== "claimed") continue;
          record.status = "paused";
          record.claimId = null;
          changed = true;
        }
        if (changed) await save();
      });
    },
    claim(key, max) {
      return enqueue(async () => {
        await load();
        const existing = state[key];
        if (existing?.status === "claimed") return { claim: null, reason: "claimed" as const };
        if (existing?.status === "paused") return { claim: null, reason: "paused" as const };
        if (existing?.status === "limit_reached") return { claim: null, reason: "limit_reached" as const };
        const count = existing?.count ?? 0;
        if (count >= max) {
          state[key] = { mode: "automatic", status: "limit_reached", count, max, claimId: null };
          await save();
          return { claim: null, reason: "limit_reached" as const };
        }
        // ponytail: the loaded plugin's serialized watcher is the CAS boundary; use a host CAS surface if plugins can run concurrently.
        const claim = { claimId: `${key}:${count + 1}`, count: count + 1, max };
        state[key] = { mode: "automatic", status: "claimed", count: claim.count, max, claimId: claim.claimId };
        await save();
        return { claim };
      });
    },
    complete(key, claimId) {
      return enqueue(async () => {
        await load();
        const record = state[key];
        if (!record || record.status !== "claimed" || record.claimId !== claimId) throw new Error("continuation claim is not current");
        record.status = "ready";
        record.claimId = null;
        await save();
      });
    },
    resume(key, resetCount = false) {
      return enqueue(async () => {
        await load();
        const record = state[key];
        if (!record || record.status === "claimed") throw new Error("continuation is not paused");
        record.status = "ready";
        record.claimId = null;
        if (resetCount) record.count = 0;
        await save();
      });
    },
  };
}

export function continuationModeFor(assignmentKind: LaneState["assignment_kind"]): ContinuationMode {
  return assignmentKind === "write" ? "automatic" : assignmentKind === "review" ? "approval" : "tracking";
}

export interface LaneWatcher {
  observe(
    threadId: string,
    status: ThreadStatus,
    pendingExternalWait?: boolean,
    archived?: boolean,
  ): Promise<void>;
  poll(): Promise<void>;
  recover(): Promise<void>;
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
  continuationLedger?: ContinuationLedger;
  maxContinuations?: number;
  onAlert?: (alert: LaneWatcherAlert) => void;
}): LaneWatcher {
  const supervisorThreadId = options.supervisorThreadId ?? SUPERVISOR_THREAD_ID;
  const continuationLedger = options.continuationLedger ?? createContinuationLedger();
  const maxContinuations = Number.isInteger(options.maxContinuations) && (options.maxContinuations ?? 0) > 0
    ? options.maxContinuations as number
    : DEFAULT_MAX_CONTINUATIONS;
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

  const viewFor = (lane: LaneState, status: ThreadStatus): LaneView => ({
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

  const alert = (kind: LaneWatcherAlert["kind"], lane: LaneView, count: number, max: number) => {
    options.onAlert?.({ kind, lane, count, max });
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
      const view = viewFor(lane, status);
      const mode = continuationModeFor(lane.assignment_kind);
      if (mode === "tracking") continue;
      if (mode === "approval") {
        alert("approval_required", view, 0, maxContinuations);
        continue;
      }

      const claimed = await continuationLedger.claim(key, maxContinuations);
      if (!claimed.claim) {
        if (claimed.reason === "limit_reached") alert("limit_reached", view, maxContinuations, maxContinuations);
        if (claimed.reason === "paused") alert("restart_review", view, 0, maxContinuations);
        continue;
      }
      try {
        await options.steer(view);
        await continuationLedger.complete(key, claimed.claim.claimId);
      } catch (error) {
        alert("delivery_uncertain", view, claimed.claim.count, claimed.claim.max);
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
    recover() {
      return enqueue(() => continuationLedger.recover());
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
