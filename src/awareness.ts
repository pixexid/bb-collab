import type { BbPluginApi, PluginThreadEventPayloads } from "@bb/plugin-sdk";
import { writingLaneCeilingForProject, type SqliteDatabase } from "./foundation.js";

export const SUPERVISOR_THREAD_ID = "thr_b94i3csnme";
export const DEFAULT_MAX_CONTINUATIONS = 3;
export const OPERATOR_WAIT_FYI_THRESHOLD_MS = 15 * 60_000;

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

export interface OperatorWait {
  reason: "awaiting_operator";
  createdAtMs: number;
}

export type LaneQueueState = "ready" | "running" | "deferred";

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
  queueState: LaneQueueState;
  queueBlocked: boolean;
  nextStartable: boolean;
  deferredReason: OperatorWait["reason"] | null;
  deferredAtMs: number | null;
  deferredAgeMs: number | null;
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

export interface OperatorWaitAlertPersistence {
  read(): Promise<unknown>;
  write(state: Record<string, true>): Promise<void>;
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
  kind: "approval_required" | "limit_reached" | "restart_review" | "delivery_uncertain" | "operator_wait_fyi";
  lane: LaneView;
  count: number;
  max: number;
};

function operatorWaitAlertState(input: unknown): Record<string, true> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const state: Record<string, true> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== true) throw new Error("invalid operator wait alert state");
    state[key] = true;
  }
  return state;
}

function createOperatorWaitAlertLedger(persistence?: OperatorWaitAlertPersistence) {
  let state: Record<string, true> = {};
  let loaded = false;
  let queue = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const load = async () => {
    if (loaded) return;
    state = operatorWaitAlertState(persistence ? await persistence.read() : null);
    loaded = true;
  };
  const save = () => persistence?.write(structuredClone(state));

  return {
    recover: () => enqueue(async () => { await load(); }),
    notified: (key: string) => enqueue(async () => { await load(); return state[key] === true; }),
    mark: (key: string) => enqueue(async () => {
      await load();
      if (state[key]) return;
      state[key] = true;
      await save();
    }),
    clear: (key: string) => enqueue(async () => {
      await load();
      if (!state[key]) return;
      delete state[key];
      await save();
    }),
  };
}

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
    operatorWait?: OperatorWait | null,
  ): Promise<void>;
  poll(): Promise<void>;
  recover(): Promise<void>;
}

export interface WorkerObservation {
  status: ThreadStatus;
  pendingExternalWait: boolean;
  archived: boolean;
  operatorWait?: OperatorWait | null;
  operatorWaitKnown?: boolean;
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

export function openLaneViews(
  db: SqliteDatabase,
  now = Date.now(),
  operatorWaits: ReadonlyMap<string, OperatorWait> = new Map(),
): LaneView[] {
  const lanes = readLaneStates(db)
    .filter((lane) => OPEN_ATTEMPT_STATES.has(lane.attempt_state))
    .map((lane) => {
      const operatorWait = lane.thread_id ? operatorWaits.get(lane.thread_id) ?? null : null;
      return {
      projectId: lane.project_id,
      laneId: lane.lane_id,
      assignmentId: lane.assignment_id,
      assignmentKind: lane.assignment_kind,
      workItemId: lane.work_item_id,
      threadId: lane.thread_id,
      executionAttemptId: lane.execution_attempt_id,
      attemptState: lane.attempt_state,
      workerStatus: null,
      waitingOn: operatorWait?.reason ?? (lane.terminal_report_digest === null ? "terminal receipt" : null),
      ageMs: Math.max(0, now - lane.created_at_ms),
      tone: lane.attempt_state === "running" ? "running" : "default",
      queueState: operatorWait ? "deferred" as const : lane.attempt_state === "running" ? "running" as const : "ready" as const,
      queueBlocked: false,
      nextStartable: false,
      deferredReason: operatorWait?.reason ?? null,
      deferredAtMs: operatorWait?.createdAtMs ?? null,
      deferredAgeMs: operatorWait ? Math.max(0, now - operatorWait.createdAtMs) : null,
    } satisfies LaneView;
    });
  const startable = new Set<string>();
  const readyWriterCount = new Map<string, number>();
  const occupiedWriterCount = new Map<string, number>();
  const ceilingByProject = new Map<string, number>();
  for (const lane of lanes) {
    if (lane.assignmentKind !== "write") continue;
    if (lane.queueState === "deferred" || lane.queueState === "running" || (lane.attemptState !== "prepared" && lane.attemptState !== "armed")) {
      occupiedWriterCount.set(lane.projectId, (occupiedWriterCount.get(lane.projectId) ?? 0) + 1);
    }
  }
  for (const lane of lanes) {
    if (lane.queueState !== "ready" || (lane.attemptState !== "prepared" && lane.attemptState !== "armed") || lane.deferredReason) continue;
    if (lane.assignmentKind !== "write") {
      startable.add(lane.executionAttemptId);
      continue;
    }
    const ready = readyWriterCount.get(lane.projectId) ?? 0;
    const occupied = occupiedWriterCount.get(lane.projectId) ?? 0;
    const ceiling = ceilingByProject.get(lane.projectId) ?? writingLaneCeilingForProject(db, lane.projectId);
    ceilingByProject.set(lane.projectId, ceiling);
    const available = Math.max(0, ceiling - occupied);
    if (ready < available) {
      startable.add(lane.executionAttemptId);
      readyWriterCount.set(lane.projectId, ready + 1);
    }
  }
  return lanes.map((lane) => ({
    ...lane,
    queueBlocked: lane.queueState === "ready" && (lane.attemptState === "prepared" || lane.attemptState === "armed") && !startable.has(lane.executionAttemptId),
    nextStartable: startable.has(lane.executionAttemptId),
  }));
}

export function createLaneWatcher(options: {
  readLanes: () => LaneState[];
  steer: (lane: LaneView) => Promise<void>;
  isExternallyWaiting?: (threadId: string) => Promise<boolean>;
  readWorker?: (threadId: string) => Promise<WorkerObservation>;
  supervisorThreadId?: string;
  continuationLedger?: ContinuationLedger;
  operatorWaitAlertPersistence?: OperatorWaitAlertPersistence;
  operatorWaitFyiThresholdMs?: number;
  readOperatorWait?: (threadId: string) => Promise<OperatorWait | null>;
  maxContinuations?: number;
  onAlert?: (alert: LaneWatcherAlert) => void;
}): LaneWatcher {
  const supervisorThreadId = options.supervisorThreadId ?? SUPERVISOR_THREAD_ID;
  const continuationLedger = options.continuationLedger ?? createContinuationLedger();
  const operatorWaitAlertLedger = createOperatorWaitAlertLedger(options.operatorWaitAlertPersistence);
  const operatorWaitFyiThresholdMs = Number.isInteger(options.operatorWaitFyiThresholdMs) && (options.operatorWaitFyiThresholdMs ?? 0) >= 0
    ? options.operatorWaitFyiThresholdMs as number
    : OPERATOR_WAIT_FYI_THRESHOLD_MS;
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

  const viewFor = (lane: LaneState, status: ThreadStatus, now: number, operatorWait: OperatorWait | null): LaneView => ({
    projectId: lane.project_id,
    laneId: lane.lane_id,
    assignmentId: lane.assignment_id,
    assignmentKind: lane.assignment_kind,
    workItemId: lane.work_item_id,
    threadId: lane.thread_id,
    executionAttemptId: lane.execution_attempt_id,
    attemptState: lane.attempt_state,
    workerStatus: status,
    waitingOn: operatorWait?.reason ?? "terminal receipt",
    ageMs: Math.max(0, now - lane.created_at_ms),
    tone: "error",
    queueState: operatorWait ? "deferred" : lane.attempt_state === "running" ? "running" : "ready",
    queueBlocked: false,
    nextStartable: false,
    deferredReason: operatorWait?.reason ?? null,
    deferredAtMs: operatorWait?.createdAtMs ?? null,
    deferredAgeMs: operatorWait ? Math.max(0, now - operatorWait.createdAtMs) : null,
  });

  const alert = (kind: LaneWatcherAlert["kind"], lane: LaneView, count: number, max: number) => {
    options.onAlert?.({ kind, lane, count, max });
  };

  const observeNow = async (
    threadId: string,
    status: ThreadStatus,
    pendingExternalWait?: boolean,
    archived = false,
    suppliedOperatorWait?: OperatorWait | null,
    suppliedOperatorWaitKnown = status !== "idle" || suppliedOperatorWait !== undefined || !options.readOperatorWait,
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

    let operatorWait = suppliedOperatorWait ?? null;
    let operatorWaitKnown = suppliedOperatorWaitKnown;
    if (!archived && status === "idle" && suppliedOperatorWait === undefined && options.readOperatorWait) {
      try {
        operatorWait = await options.readOperatorWait(threadId);
      } catch {
        operatorWait = null;
        operatorWaitKnown = false;
      }
    }
    let waiting = pendingExternalWait ?? false;
    if (operatorWait) waiting = true;
    if (!archived && status === "idle" && pendingExternalWait === undefined && !operatorWait && options.isExternallyWaiting) {
      try {
        waiting = await options.isExternallyWaiting(threadId);
      } catch {
        // Unknown wait state is not evidence that steering is safe.
        waiting = true;
      }
    }

    const now = Date.now();
    if (archived || status !== "idle" || (waiting && !operatorWait)) {
      for (const lane of candidates) {
        const key = laneKey(lane);
        coalesced.delete(key);
        if (archived || (operatorWaitKnown && !operatorWait)) await operatorWaitAlertLedger.clear(key);
      }
      return;
    }

    for (const lane of candidates) {
      const key = laneKey(lane);
      if (lane.terminal_report_digest !== null) {
        await operatorWaitAlertLedger.clear(key);
        continue;
      }

      if (operatorWait) {
        coalesced.delete(key);
        const view = viewFor(lane, status, now, operatorWait);
        if (view.deferredAgeMs !== null && view.deferredAgeMs >= operatorWaitFyiThresholdMs && !(await operatorWaitAlertLedger.notified(key))) {
          await operatorWaitAlertLedger.mark(key);
          alert("operator_wait_fyi", view, 0, 0);
        }
        continue;
      }

      await operatorWaitAlertLedger.clear(key);
      if (coalesced.has(key)) continue;

      coalesced.add(key);
      const view = viewFor(lane, status, now, null);
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
    observe(threadId, status, pendingExternalWait, archived, operatorWait) {
      if (threadId === supervisorThreadId) return Promise.resolve();
      return enqueue(() => observeNow(threadId, status, pendingExternalWait, archived, operatorWait));
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
            observation.operatorWait,
            observation.operatorWaitKnown,
          );
        }
      });
    },
    recover() {
      return enqueue(async () => {
        await continuationLedger.recover();
        await operatorWaitAlertLedger.recover();
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
