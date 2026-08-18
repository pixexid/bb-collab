import type { BbPluginApi, PluginThreadEventPayloads } from "@bb/plugin-sdk";
import type { SqliteDatabase } from "./foundation.js";

export const DEFAULT_MAX_CONTINUATIONS = 3;
export const OPERATOR_WAIT_FYI_THRESHOLD_MS = 15 * 60_000;
export const WRONGFUL_IDLE_THRESHOLD_MS = 10 * 60_000;

export const OPEN_ATTEMPT_STATES: ReadonlySet<string> = new Set([
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

export type RegisteredWaitSourceEvent = "terminal" | "failure";

export interface RegisteredWait {
  waitId: string;
  waiterThreadId: string;
  sourceThreadId: string;
  sourceEvent: RegisteredWaitSourceEvent;
  deadlineAtMs: number;
  /** Legacy declarations have no verified waker and never suppress the watchdog. */
  wakerSchedule: string | null;
  declaredAtMs: number | null;
}

export interface WaitEvent extends RegisteredWait {
  reason: "source_terminal" | "source_failure" | "deadline_expired";
  firedAtMs: number;
}

export interface WaitRegistryPersistence {
  read(): Promise<unknown>;
  write(state: { waits: RegisteredWait[]; fired: Record<string, WaitEvent["reason"]> }): Promise<void>;
}

export interface WaitRegistry {
  recover(): Promise<void>;
  register(wait: RegisteredWait): Promise<void>;
  list(): RegisteredWait[];
  state(waitId: string): "pending" | "fired" | "unknown";
  fire(waitId: string, reason: WaitEvent["reason"], firedAtMs: number): Promise<WaitEvent | null>;
  /** Fired waits with their reason and waiter, for the durable validator. */
  firedList(): Array<{ waitId: string; reason: WaitEvent["reason"]; waiterThreadId: string }>;
}

function normalizeRegisteredWait(input: unknown): RegisteredWait {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid registered wait");
  const value = input as Record<string, unknown>;
  if (
    typeof value.waitId !== "string" || value.waitId.length === 0 ||
    typeof value.waiterThreadId !== "string" || value.waiterThreadId.length === 0 ||
    typeof value.sourceThreadId !== "string" || value.sourceThreadId.length === 0 ||
    (value.sourceEvent !== "terminal" && value.sourceEvent !== "failure") ||
    !Number.isInteger(value.deadlineAtMs) || (value.deadlineAtMs as number) < 0
  ) throw new Error("registered wait requires waiter, source, event, and deadline");
  return {
    waitId: value.waitId,
    waiterThreadId: value.waiterThreadId,
    sourceThreadId: value.sourceThreadId,
    sourceEvent: value.sourceEvent,
    deadlineAtMs: value.deadlineAtMs as number,
    wakerSchedule: typeof value.wakerSchedule === "string" && value.wakerSchedule.length > 0 ? value.wakerSchedule : null,
    declaredAtMs: Number.isInteger(value.declaredAtMs) && (value.declaredAtMs as number) >= 0 ? value.declaredAtMs as number : null,
  };
}

function waitRegistryState(input: unknown): { waits: RegisteredWait[]; fired: Record<string, WaitEvent["reason"]> } {
  if (input === undefined || input === null) return { waits: [], fired: {} };
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid wait registry state");
  const value = input as Record<string, unknown>;
  if (!Array.isArray(value.waits) || !value.fired || typeof value.fired !== "object" || Array.isArray(value.fired)) {
    throw new Error("invalid wait registry state");
  }
  const waits = value.waits.map(normalizeRegisteredWait);
  const byId = new Map<string, RegisteredWait>();
  for (const wait of waits) {
    const existing = byId.get(wait.waitId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(wait)) throw new Error("conflicting registered wait");
    byId.set(wait.waitId, wait);
  }
  const fired: Record<string, WaitEvent["reason"]> = {};
  for (const [waitId, reason] of Object.entries(value.fired)) {
    if (!byId.has(waitId) || !["source_terminal", "source_failure", "deadline_expired"].includes(reason as string)) {
      throw new Error("invalid fired wait");
    }
    fired[waitId] = reason as WaitEvent["reason"];
  }
  return { waits: [...byId.values()], fired };
}

export function createWaitRegistry(persistence?: WaitRegistryPersistence): WaitRegistry {
  let state: { waits: RegisteredWait[]; fired: Record<string, WaitEvent["reason"]> } = { waits: [], fired: {} };
  let loaded = false;
  let queue = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const load = async () => {
    if (loaded) return;
    state = waitRegistryState(persistence ? await persistence.read() : null);
    loaded = true;
  };
  return {
    recover: () => enqueue(async () => { await load(); }),
    register: (input) => enqueue(async () => {
      await load();
      const wait = normalizeRegisteredWait(input);
      const existing = state.waits.find((candidate) => candidate.waitId === wait.waitId);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(wait)) throw new Error("conflicting registered wait");
        return;
      }
      const waits = [...state.waits, wait];
      await persistence?.write(structuredClone({ waits, fired: state.fired }));
      state = { waits, fired: state.fired };
    }),
    list: () => state.waits.map((wait) => ({ ...wait })),
    state: (waitId) => state.fired[waitId] ? "fired" : state.waits.some((wait) => wait.waitId === waitId) ? "pending" : "unknown",
    firedList: () => state.waits
      .filter((wait) => state.fired[wait.waitId] !== undefined)
      .map((wait) => ({ waitId: wait.waitId, reason: state.fired[wait.waitId], waiterThreadId: wait.waiterThreadId })),
    fire: (waitId, reason, firedAtMs) => enqueue(async () => {
      await load();
      const wait = state.waits.find((candidate) => candidate.waitId === waitId);
      if (!wait || state.fired[waitId]) return null;
      const event = { ...wait, reason, firedAtMs } satisfies WaitEvent;
      const fired = { ...state.fired, [waitId]: reason };
      await persistence?.write(structuredClone({ waits: state.waits, fired }));
      state = { waits: state.waits, fired };
      return event;
    }),
  };
}

export interface RoleHolderState {
  project_id: string;
  role_id: string;
  role_generation: number;
  execution_attempt_id: string;
  thread_id: string;
}

export function roleIdleKey(holder: RoleHolderState, queueHeadId: string): string {
  return `${holder.project_id}:${holder.role_id}:${holder.role_generation}:${queueHeadId}`;
}

export interface RoleQueueScope {
  projectId: string;
  nextStartable: boolean;
  queueHeadId: string | null;
  deferredReason: OperatorWait["reason"] | null;
}

export interface RoleIdleView {
  projectId: string;
  roleId: string;
  roleGeneration: number;
  executionAttemptId: string;
  threadId: string;
  queueHeadId: string;
  idleAgeMs: number;
}

export type RoleWakeResult =
  | { attempted: true; delivered: boolean }
  | { attempted: false; delivered: false; refusal: "policy" | "error" };

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

export interface RoleIdlePersistence {
  read(): Promise<unknown>;
  write(state: Record<string, RoleIdleRecord>): Promise<void>;
}

export interface RoleIdleRecord {
  steerCount: number;
  failedSteers: number;
  escalated: boolean;
  idleSinceMs: number | null;
  lastSteerAtMs: number | null;
  awaitingSteerOutcome: boolean;
  lastFleetWakeAtMs: number | null;
  lastRecoveryWakeAtMs: number | null;
  lastStartableQueueWakeAtMs: number | null;
  lastStaleWaitWakeAtMs: number | null;
  lastOwedActWakeAtMs: number | null;
  lastEscalationAtMs: number | null;
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
} | {
  kind: "wrongful_idle_fyi";
  lane: null;
  role: RoleIdleView;
  count: 2;
  max: 2;
};

type LaneAlertKind = "approval_required" | "limit_reached" | "restart_review" | "delivery_uncertain" | "operator_wait_fyi";

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

function roleIdleState(input: unknown): Record<string, RoleIdleRecord> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const state: Record<string, RoleIdleRecord> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid role idle state");
    const record = value as Record<string, unknown>;
    const failedSteers = typeof record.failedSteers === "number" ? record.failedSteers : 0;
    const idleSinceMs = typeof record.idleSinceMs === "number" && Number.isFinite(record.idleSinceMs) ? record.idleSinceMs : null;
    const lastSteerAtMs = typeof record.lastSteerAtMs === "number" && Number.isFinite(record.lastSteerAtMs) ? record.lastSteerAtMs : null;
    const awaitingSteerOutcome = record.awaitingSteerOutcome === true;
    const lastFleetWakeAtMs = typeof record.lastFleetWakeAtMs === "number" && Number.isFinite(record.lastFleetWakeAtMs) ? record.lastFleetWakeAtMs : null;
    const lastRecoveryWakeAtMs = typeof record.lastRecoveryWakeAtMs === "number" && Number.isFinite(record.lastRecoveryWakeAtMs) ? record.lastRecoveryWakeAtMs : null;
    const lastStartableQueueWakeAtMs = typeof record.lastStartableQueueWakeAtMs === "number" && Number.isFinite(record.lastStartableQueueWakeAtMs) ? record.lastStartableQueueWakeAtMs : null;
    const lastStaleWaitWakeAtMs = typeof record.lastStaleWaitWakeAtMs === "number" && Number.isFinite(record.lastStaleWaitWakeAtMs) ? record.lastStaleWaitWakeAtMs : null;
    const lastOwedActWakeAtMs = typeof record.lastOwedActWakeAtMs === "number" && Number.isFinite(record.lastOwedActWakeAtMs) ? record.lastOwedActWakeAtMs : null;
    const lastEscalationAtMs = typeof record.lastEscalationAtMs === "number" && Number.isFinite(record.lastEscalationAtMs) ? record.lastEscalationAtMs : null;
    if (!Number.isInteger(record.steerCount) || (record.steerCount as number) < 0 || (record.steerCount as number) > 2 || !Number.isInteger(failedSteers) || failedSteers < 0 || failedSteers > 2 || (idleSinceMs !== null && idleSinceMs < 0) || (lastSteerAtMs !== null && lastSteerAtMs < 0) || (lastFleetWakeAtMs !== null && lastFleetWakeAtMs < 0) || (lastRecoveryWakeAtMs !== null && lastRecoveryWakeAtMs < 0) || (lastStartableQueueWakeAtMs !== null && lastStartableQueueWakeAtMs < 0) || (lastStaleWaitWakeAtMs !== null && lastStaleWaitWakeAtMs < 0) || (lastOwedActWakeAtMs !== null && lastOwedActWakeAtMs < 0) || (lastEscalationAtMs !== null && lastEscalationAtMs < 0) || typeof record.escalated !== "boolean") {
      throw new Error("invalid role idle state");
    }
    state[key] = { steerCount: record.steerCount as number, failedSteers, escalated: record.escalated as boolean, idleSinceMs, lastSteerAtMs, awaitingSteerOutcome, lastFleetWakeAtMs, lastRecoveryWakeAtMs, lastStartableQueueWakeAtMs, lastStaleWaitWakeAtMs, lastOwedActWakeAtMs, lastEscalationAtMs };
  }
  return state;
}

function emptyRoleIdleRecord(): RoleIdleRecord {
  return { steerCount: 0, failedSteers: 0, escalated: false, idleSinceMs: null, lastSteerAtMs: null, awaitingSteerOutcome: false, lastFleetWakeAtMs: null, lastRecoveryWakeAtMs: null, lastStartableQueueWakeAtMs: null, lastStaleWaitWakeAtMs: null, lastOwedActWakeAtMs: null, lastEscalationAtMs: null };
}

export function createRoleIdleLedger(persistence?: RoleIdlePersistence) {
  let state: Record<string, RoleIdleRecord> = {};
  let loaded = false;
  let queue = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const load = async () => {
    if (loaded) return;
    state = roleIdleState(persistence ? await persistence.read() : null);
    loaded = true;
  };
  const save = () => persistence?.write(structuredClone(state));

  return {
    recover: () => enqueue(async () => { await load(); }),
    get: (key: string) => enqueue(async () => { await load(); return state[key] ?? null; }),
    observeIdle: (key: string, idleSinceMs: number) => enqueue(async () => {
      await load();
      const record = state[key];
      if (record?.idleSinceMs !== null && record?.idleSinceMs !== undefined) {
        if (record.awaitingSteerOutcome) {
          record.awaitingSteerOutcome = false;
          record.idleSinceMs = idleSinceMs;
          await save();
        }
        return { ...record };
      }
      state[key] = { ...(record ?? emptyRoleIdleRecord()), idleSinceMs, awaitingSteerOutcome: false };
      await save();
      return { ...state[key] };
    }),
    resetIdle: (key: string) => enqueue(async () => {
      await load();
      const record = state[key];
      if (!record) return;
      state[key] = { ...emptyRoleIdleRecord(), lastFleetWakeAtMs: record.lastFleetWakeAtMs, lastRecoveryWakeAtMs: record.lastRecoveryWakeAtMs, lastStartableQueueWakeAtMs: record.lastStartableQueueWakeAtMs, lastStaleWaitWakeAtMs: record.lastStaleWaitWakeAtMs, lastOwedActWakeAtMs: record.lastOwedActWakeAtMs, lastEscalationAtMs: record.lastEscalationAtMs };
      await save();
    }),
    preserveAfterSteerWake: (key: string) => enqueue(async () => {
      await load();
      const record = state[key];
      return record?.awaitingSteerOutcome === true;
    }),
    recordSteer: (key: string, failed: boolean, steeredAtMs: number) => enqueue(async () => {
      await load();
      const record = state[key] ?? emptyRoleIdleRecord();
      record.steerCount = Math.min(2, record.steerCount + 1);
      if (failed) record.failedSteers = Math.min(2, record.failedSteers + 1);
      record.lastSteerAtMs = steeredAtMs;
      record.awaitingSteerOutcome = !failed;
      state[key] = record;
      await save();
      return { ...record };
    }),
    markEscalated: (key: string) => enqueue(async () => {
      await load();
      const record = state[key] ?? { ...emptyRoleIdleRecord(), steerCount: 2 };
      if (record.escalated) return false;
      record.escalated = true;
      state[key] = record;
      await save();
      return true;
    }),
    clearPrefixExcept: (prefix: string, keepKey?: string) => enqueue(async () => {
      await load();
      let changed = false;
      for (const key of Object.keys(state)) {
        if (key.startsWith(prefix) && key !== keepKey) {
          delete state[key];
          changed = true;
        }
      }
      if (changed) await save();
    }),
    recordFleetWake: (key: string, sentAtMs: number) => enqueue(async () => {
      await load();
      const next = { ...(state[key] ?? emptyRoleIdleRecord()), lastFleetWakeAtMs: sentAtMs };
      const nextState = { ...state, [key]: next };
      await persistence?.write(structuredClone(nextState));
      state = nextState;
    }),
    recordRecoveryWake: (key: string, sentAtMs: number) => enqueue(async () => {
      await load();
      const nextState = { ...state, [key]: { ...(state[key] ?? emptyRoleIdleRecord()), lastRecoveryWakeAtMs: sentAtMs } };
      await persistence?.write(structuredClone(nextState));
      state = nextState;
    }),
    recordStartableQueueWake: (key: string, sentAtMs: number) => enqueue(async () => {
      await load();
      const nextState = { ...state, [key]: { ...(state[key] ?? emptyRoleIdleRecord()), lastStartableQueueWakeAtMs: sentAtMs } };
      await persistence?.write(structuredClone(nextState));
      state = nextState;
    }),
    recordStaleWaitWake: (key: string, sentAtMs: number) => enqueue(async () => {
      await load();
      const nextState = { ...state, [key]: { ...(state[key] ?? emptyRoleIdleRecord()), lastStaleWaitWakeAtMs: sentAtMs } };
      await persistence?.write(structuredClone(nextState));
      state = nextState;
    }),
    recordOwedActWake: (key: string, sentAtMs: number) => enqueue(async () => {
      await load();
      const nextState = { ...state, [key]: { ...(state[key] ?? emptyRoleIdleRecord()), lastOwedActWakeAtMs: sentAtMs } };
      await persistence?.write(structuredClone(nextState));
      state = nextState;
    }),
    recordEscalation: (key: string, sentAtMs: number) => enqueue(async () => {
      await load();
      const record = state[key] ?? emptyRoleIdleRecord();
      const nextState = { ...state, [key]: { ...record, lastEscalationAtMs: sentAtMs } };
      await persistence?.write(structuredClone(nextState));
      state = nextState;
    }),
    clearWakeHistory: (prefix: string) => enqueue(async () => {
      await load();
      for (const key of Object.keys(state)) if (key.startsWith(prefix)) state[key] = { ...state[key]!, idleSinceMs: null, lastFleetWakeAtMs: null, lastRecoveryWakeAtMs: null, lastStartableQueueWakeAtMs: null, lastStaleWaitWakeAtMs: null, lastOwedActWakeAtMs: null, lastEscalationAtMs: null };
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
  registerWait(wait: RegisteredWait): Promise<void>;
  observe(
    threadId: string,
    status: ThreadStatus,
    pendingExternalWait?: boolean,
    archived?: boolean,
    operatorWait?: OperatorWait | null,
  ): Promise<void>;
  poll(): Promise<void>;
  wakeRole(role: RoleIdleView): Promise<RoleWakeResult>;
  recover(): Promise<void>;
  readRoleIdle(key: string): Promise<RoleIdleRecord | null>;
  observeRoleIdle(key: string, idleSinceMs: number): Promise<RoleIdleRecord>;
  resetRoleIdle(key: string): Promise<void>;
  recordRoleWake(key: string, sentAtMs: number): Promise<void>;
}

export interface WorkerObservation {
  status: ThreadStatus;
  pendingExternalWait: boolean;
  archived: boolean;
  projectId?: string;
  operatorWait?: OperatorWait | null;
  operatorWaitKnown?: boolean;
  idleSinceMs?: number | null;
}

type RegisteredWaitState = "none" | "pending" | "unknown" | "fired";

function mergeRegisteredWaitState(current: RegisteredWaitState | undefined, next: Exclude<RegisteredWaitState, "none">): RegisteredWaitState {
  const rank: Record<Exclude<RegisteredWaitState, "none">, number> = { fired: 1, pending: 2, unknown: 3 };
  return !current || current === "none" || rank[next] > rank[current] ? next : current;
}

interface WaitSourceObservation {
  known: boolean;
  terminal: boolean;
  failed: boolean;
}

interface WaitContext {
  known: boolean;
  byWaiter: ReadonlyMap<string, RegisteredWaitState>;
  events: readonly WaitEvent[];
}

export function readRoleHolderStates(db: SqliteDatabase): RoleHolderState[] {
  return db
    .prepare(
      `SELECT attempts.project_id, attempts.role_id, attempts.role_generation,
              attempts.execution_attempt_id, attempts.thread_id
       FROM execution_attempts AS attempts
       JOIN role_generation_heads AS heads
         ON heads.project_id = attempts.project_id
        AND heads.role_id = attempts.role_id
        AND heads.current_generation = attempts.role_generation
       JOIN role_generations AS generations
         ON generations.project_id = attempts.project_id
        AND generations.role_id = attempts.role_id
        AND generations.generation = attempts.role_generation
        AND generations.holder_execution_attempt_id = attempts.execution_attempt_id
       WHERE attempts.origin = 'role_holder'
         AND attempts.thread_id IS NOT NULL
         AND generations.status = 'active'
       ORDER BY attempts.project_id, attempts.role_id, attempts.role_generation`,
    )
    .all() as RoleHolderState[];
}

export function roleQueueScopes(lanes: readonly LaneView[]): RoleQueueScope[] {
  const projectIds = new Set(lanes.map((lane) => lane.projectId));
  return [...projectIds].map((projectId) => {
    const next = lanes.find((lane) => lane.projectId === projectId && lane.nextStartable);
    return {
      projectId,
      nextStartable: next !== undefined,
      queueHeadId: next?.executionAttemptId ?? null,
      deferredReason: next?.deferredReason ?? null,
    };
  });
}

export function createLaneWatcher(options: {
  readLanes: () => LaneState[];
  steer: (lane: LaneView) => Promise<void>;
  isExternallyWaiting?: (threadId: string) => Promise<boolean>;
  readWorker?: (threadId: string) => Promise<WorkerObservation>;
  continuationLedger?: ContinuationLedger;
  waitRegistry?: WaitRegistry;
  readRegisteredWaits?: () => RegisteredWait[] | Promise<RegisteredWait[]>;
  onWaitEvent?: (event: WaitEvent) => void | Promise<void>;
  operatorWaitAlertPersistence?: OperatorWaitAlertPersistence;
  operatorWaitFyiThresholdMs?: number;
  readOperatorWait?: (threadId: string) => Promise<OperatorWait | null>;
  readRoleHolders?: () => RoleHolderState[];
  readRoleScopes?: () => Promise<RoleQueueScope[]> | RoleQueueScope[];
  roleIdlePersistence?: RoleIdlePersistence;
  roleIdleThresholdMs?: number;
  steerRole?: (role: RoleIdleView) => Promise<boolean | void | "error">;
  onRoleSuccessionRequired?: (role: RoleIdleView) => void;
  now?: () => number;
  maxContinuations?: number;
  onAlert?: (alert: LaneWatcherAlert) => void;
}): LaneWatcher {
  const continuationLedger = options.continuationLedger ?? createContinuationLedger();
  const waitRegistry = options.waitRegistry ?? createWaitRegistry();
  const operatorWaitAlertLedger = createOperatorWaitAlertLedger(options.operatorWaitAlertPersistence);
  const roleIdleLedger = createRoleIdleLedger(options.roleIdlePersistence);
  const roleIdleThresholdMs = Number.isInteger(options.roleIdleThresholdMs) && (options.roleIdleThresholdMs ?? 0) >= 0
    ? options.roleIdleThresholdMs as number
    : WRONGFUL_IDLE_THRESHOLD_MS;
  const now = options.now ?? Date.now;
  const operatorWaitFyiThresholdMs = Number.isInteger(options.operatorWaitFyiThresholdMs) && (options.operatorWaitFyiThresholdMs ?? 0) >= 0
    ? options.operatorWaitFyiThresholdMs as number
    : OPERATOR_WAIT_FYI_THRESHOLD_MS;
  const maxContinuations = Number.isInteger(options.maxContinuations) && (options.maxContinuations ?? 0) > 0
    ? options.maxContinuations as number
    : DEFAULT_MAX_CONTINUATIONS;
  const coalesced = new Set<string>();
  let queue = Promise.resolve();

  const readWaitContext = async (
    allLanes: LaneState[],
    suppliedSource?: { threadId: string; status: ThreadStatus; archived: boolean },
  ): Promise<WaitContext> => {
    let waits: RegisteredWait[];
    try {
      await waitRegistry.recover();
      waits = (options.readRegisteredWaits ? await options.readRegisteredWaits() : waitRegistry.list()).map(normalizeRegisteredWait);
      if (options.readRegisteredWaits) for (const wait of waits) await waitRegistry.register(wait);
    } catch {
      return { known: false, byWaiter: new Map(), events: [] };
    }
    if (waits.length === 0) return { known: true, byWaiter: new Map(), events: [] };

    const sourceStates = new Map<string, WaitSourceObservation>();
    for (const sourceThreadId of new Set(waits.map((wait) => wait.sourceThreadId))) {
      const sourceLanes = allLanes.filter((lane) => lane.thread_id === sourceThreadId);
      const terminalFromLane = sourceLanes.some((lane) => lane.terminal_report_digest !== null || !OPEN_ATTEMPT_STATES.has(lane.attempt_state));
      let observation: WorkerObservation | null = null;
      if (suppliedSource?.threadId === sourceThreadId) {
        observation = {
          status: suppliedSource.status,
          pendingExternalWait: false,
          archived: suppliedSource.archived,
        };
      } else if (options.readWorker) {
        try {
          observation = await options.readWorker(sourceThreadId);
        } catch {
          observation = null;
        }
      }
      const failedFromLane = sourceLanes.some((lane) => lane.attempt_state === "failed");
      sourceStates.set(sourceThreadId, {
        known: terminalFromLane || observation !== null,
        terminal: terminalFromLane || observation?.archived === true || observation?.status === "error",
        failed: failedFromLane || observation?.archived === true || observation?.status === "error",
      });
    }

    const byWaiter = new Map<string, RegisteredWaitState>();
    const events: WaitEvent[] = [];
    for (const wait of waits) {
      if (waitRegistry.state(wait.waitId) === "fired") {
        byWaiter.set(wait.waiterThreadId, mergeRegisteredWaitState(byWaiter.get(wait.waiterThreadId), "fired"));
        continue;
      }
      const source = sourceStates.get(wait.sourceThreadId);
      let reason: WaitEvent["reason"] | null = null;
      if (now() >= wait.deadlineAtMs) reason = "deadline_expired";
      else if (!source?.known) {
        byWaiter.set(wait.waiterThreadId, mergeRegisteredWaitState(byWaiter.get(wait.waiterThreadId), "unknown"));
        continue;
      } else if (wait.sourceEvent === "terminal" && source.terminal) reason = "source_terminal";
      else if (wait.sourceEvent === "failure" && source.failed) reason = "source_failure";
      else {
        byWaiter.set(wait.waiterThreadId, mergeRegisteredWaitState(byWaiter.get(wait.waiterThreadId), "pending"));
        continue;
      }
      let event: WaitEvent | null;
      try {
        event = await waitRegistry.fire(wait.waitId, reason, now());
      } catch {
        return { known: false, byWaiter: new Map(), events: [] };
      }
      if (event) events.push(event);
      byWaiter.set(wait.waiterThreadId, mergeRegisteredWaitState(byWaiter.get(wait.waiterThreadId), "fired"));
    }
    return { known: true, byWaiter, events };
  };

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

  const alert = (kind: LaneAlertKind, lane: LaneView, count: number, max: number) => {
    options.onAlert?.({ kind, lane, count, max });
  };

  const roleAlert = (role: RoleIdleView) => {
    options.onAlert?.({ kind: "wrongful_idle_fyi", lane: null, role, count: 2, max: 2 });
  };

  const isCurrentCanonicalHolder = (projectId: string, threadId: string): boolean => {
    if (!options.readRoleHolders) return false;
    try {
      return options.readRoleHolders()
        .filter((holder) => holder.project_id === projectId)
        .some((holder) => holder.thread_id === threadId);
    } catch {
      return true;
    }
  };

  const resolveCurrentCanonicalHolder = (holder: RoleHolderState): RoleHolderState | null | undefined => {
    if (!options.readRoleHolders) return null;
    try {
      const current = options.readRoleHolders().filter((candidate) =>
        candidate.project_id === holder.project_id && candidate.role_id === holder.role_id,
      );
      return current.length === 1 &&
        current[0]?.role_generation === holder.role_generation &&
        current[0]?.execution_attempt_id === holder.execution_attempt_id &&
        current[0]?.thread_id === holder.thread_id
        ? current[0]
        : null;
    } catch {
      return undefined;
    }
  };

  const escalateRole = async (key: string, role: RoleIdleView) => {
    if (!await roleIdleLedger.markEscalated(key)) return;
    roleAlert(role);
    options.onRoleSuccessionRequired?.(role);
  };

  const observeRoleNow = async (threadId?: string, suppliedScopes?: RoleQueueScope[], waitContext?: WaitContext): Promise<void> => {
    if (!options.readRoleHolders || !options.readRoleScopes || !options.readWorker || !options.steerRole) return;
    let holders: RoleHolderState[];
    try {
      holders = options.readRoleHolders();
    } catch {
      return;
    }
    if (holders.length === 0) return;
    if (threadId && !holders.some((holder) => holder.thread_id === threadId)) return;

    let scopes = suppliedScopes;
    if (!scopes) {
      try {
        scopes = await options.readRoleScopes();
      } catch {
        return;
      }
    }

    for (const holder of holders) {
      const projectHolders = holders.filter((candidate) => candidate.project_id === holder.project_id && candidate.role_id === holder.role_id);
      if (projectHolders.length !== 1 || !holder.thread_id) continue;
      const targetThreadId = holder.thread_id;
      if (threadId && targetThreadId !== threadId) continue;
      const prefix = `${holder.project_id}:${holder.role_id}:${holder.role_generation}:`;
      const scope = scopes.find((candidate) => candidate.projectId === holder.project_id);
      let observation: WorkerObservation;
      try {
        observation = await options.readWorker(targetThreadId);
      } catch {
        continue;
      }
      const waitState = waitContext?.byWaiter.get(targetThreadId) ?? "none";
      if (observation.projectId !== holder.project_id || waitContext && !waitContext.known || waitState === "pending" || waitState === "unknown" || observation.archived || observation.pendingExternalWait || observation.operatorWait || observation.operatorWaitKnown === false || !scope?.nextStartable || scope.deferredReason) {
        await roleIdleLedger.clearPrefixExcept(prefix);
        continue;
      }

      if (!scope.queueHeadId) {
        await roleIdleLedger.clearPrefixExcept(prefix);
        continue;
      }
      const key = roleIdleKey(holder, scope.queueHeadId);
      await roleIdleLedger.clearPrefixExcept(prefix, key);
      if (observation.status !== "idle") {
        if (await roleIdleLedger.preserveAfterSteerWake(key)) continue;
        await roleIdleLedger.resetIdle(key);
        await roleIdleLedger.clearPrefixExcept(prefix, key);
        continue;
      }
      if (observation.idleSinceMs === null || observation.idleSinceMs === undefined || !Number.isFinite(observation.idleSinceMs)) {
        await roleIdleLedger.clearPrefixExcept(prefix);
        continue;
      }
      const currentNow = now();
      const record = await roleIdleLedger.observeIdle(key, currentNow);
      const idleAgeMs = Math.max(0, currentNow - (record.idleSinceMs ?? currentNow));
      const steerAgeMs = record.lastSteerAtMs === null ? Number.POSITIVE_INFINITY : Math.max(0, currentNow - record.lastSteerAtMs);
      if (idleAgeMs < roleIdleThresholdMs) continue;
      if (record?.escalated) continue;
      if ((record?.steerCount ?? 0) >= 2) {
        if (idleAgeMs >= roleIdleThresholdMs && steerAgeMs >= roleIdleThresholdMs) {
          await escalateRole(key, {
            projectId: holder.project_id,
            roleId: holder.role_id,
            roleGeneration: holder.role_generation,
            executionAttemptId: holder.execution_attempt_id,
            threadId: targetThreadId,
            queueHeadId: scope.queueHeadId,
            idleAgeMs,
          });
        }
        continue;
      }
      if (idleAgeMs < roleIdleThresholdMs || steerAgeMs < roleIdleThresholdMs) continue;

      const role: RoleIdleView = {
        projectId: holder.project_id,
        roleId: holder.role_id,
        roleGeneration: holder.role_generation,
        executionAttemptId: holder.execution_attempt_id,
        threadId: targetThreadId,
        queueHeadId: scope.queueHeadId,
        idleAgeMs,
      };
      if (!resolveCurrentCanonicalHolder(holder)) {
        await roleIdleLedger.clearPrefixExcept(prefix);
        continue;
      }
      let failed = false;
      let delivered: boolean | void | "error" = undefined;
      try {
        delivered = await options.steerRole(role);
      } catch {
        // A failed send is itself a failed steer; the second failure escalates once.
        failed = true;
      }
      if (delivered === false || delivered === "error") {
        await roleIdleLedger.clearPrefixExcept(prefix);
        continue;
      }
      const updated = await roleIdleLedger.recordSteer(key, failed, currentNow);
      if (updated.steerCount === 2 && updated.failedSteers === 2) await escalateRole(key, role);
    }
  };

  const wakeRoleNow = async (role: RoleIdleView): Promise<RoleWakeResult> => {
    if (!options.readRoleHolders || !options.readRoleScopes || !options.readWorker || !options.steerRole) return { attempted: false, delivered: false, refusal: "policy" };
    const holder: RoleHolderState = {
      project_id: role.projectId,
      role_id: role.roleId,
      role_generation: role.roleGeneration,
      execution_attempt_id: role.executionAttemptId,
      thread_id: role.threadId,
    };
    const currentHolder = resolveCurrentCanonicalHolder(holder);
    if (!currentHolder) return { attempted: false, delivered: false, refusal: currentHolder === undefined ? "error" : "policy" };
    let scopes: RoleQueueScope[];
    let observation: WorkerObservation;
    try {
      scopes = await options.readRoleScopes();
      observation = await options.readWorker(role.threadId);
    } catch {
      return { attempted: false, delivered: false, refusal: "error" };
    }
    const scope = scopes.find((candidate) => candidate.projectId === role.projectId);
    if (
      !scope?.nextStartable ||
      scope.queueHeadId !== role.queueHeadId ||
      scope.deferredReason ||
      observation.projectId !== role.projectId ||
      observation.status !== "idle" ||
      observation.archived ||
      observation.pendingExternalWait ||
      observation.operatorWait ||
      observation.operatorWaitKnown === false ||
      observation.idleSinceMs === null ||
      observation.idleSinceMs === undefined ||
      !Number.isFinite(observation.idleSinceMs)
    ) return { attempted: false, delivered: false, refusal: "policy" };

    const prefix = `${holder.project_id}:${holder.role_id}:${holder.role_generation}:`;
    const key = `${prefix}${scope.queueHeadId}`;
    await roleIdleLedger.clearPrefixExcept(prefix, key);
    const currentNow = now();
    const record = await roleIdleLedger.observeIdle(key, observation.idleSinceMs);
    const steerAgeMs = record.lastSteerAtMs === null ? Number.POSITIVE_INFINITY : Math.max(0, currentNow - record.lastSteerAtMs);
    if (record.escalated || record.steerCount >= 2 || steerAgeMs < roleIdleThresholdMs) return { attempted: false, delivered: false, refusal: "policy" };

    const target: RoleIdleView = {
      ...role,
      threadId: holder.thread_id,
      idleAgeMs: Math.max(0, currentNow - (record.idleSinceMs ?? currentNow)),
    };
    let failed = false;
    let delivered: boolean | void | "error" = undefined;
    try {
      delivered = await options.steerRole(target);
    } catch {
      failed = true;
    }
    if (delivered === "error") return { attempted: false, delivered: false, refusal: "error" };
    if (delivered === false) {
      await roleIdleLedger.clearPrefixExcept(prefix);
      return { attempted: false, delivered: false, refusal: "policy" };
    }
    const updated = await roleIdleLedger.recordSteer(key, failed, currentNow);
    if (updated.steerCount === 2 && updated.failedSteers === 2) await escalateRole(key, target);
    return { attempted: true, delivered: !failed };
  };

  const observeNow = async (
    threadId: string,
    status: ThreadStatus,
    pendingExternalWait?: boolean,
    archived = false,
    suppliedOperatorWait?: OperatorWait | null,
    suppliedOperatorWaitKnown = status !== "idle" || suppliedOperatorWait !== undefined || !options.readOperatorWait,
    waitContext?: WaitContext,
  ): Promise<void> => {
    const allLanes = options.readLanes();
    clearResolved(allLanes);
    const candidates = allLanes.filter(
      (lane) =>
        lane.thread_id === threadId &&
        (!lane.thread_id || !isCurrentCanonicalHolder(lane.project_id, lane.thread_id)) &&
        OPEN_ATTEMPT_STATES.has(lane.attempt_state),
    );
    if (candidates.length === 0) return;

    const registeredWaitState = waitContext?.byWaiter.get(threadId) ?? "none";
    if (status === "idle" && (waitContext && (!waitContext.known || registeredWaitState === "pending" || registeredWaitState === "unknown"))) {
      for (const lane of candidates) coalesced.delete(laneKey(lane));
      return;
    }

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

    const currentNow = now();
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
        const view = viewFor(lane, status, currentNow, operatorWait);
        if (view.deferredAgeMs !== null && view.deferredAgeMs >= operatorWaitFyiThresholdMs && !(await operatorWaitAlertLedger.notified(key))) {
          await operatorWaitAlertLedger.mark(key);
          alert("operator_wait_fyi", view, 0, 0);
        }
        continue;
      }

      await operatorWaitAlertLedger.clear(key);
      if (coalesced.has(key)) continue;

      coalesced.add(key);
      const view = viewFor(lane, status, currentNow, null);
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

  const emitWaitEvents = async (context: WaitContext) => {
    for (const event of context.events) await options.onWaitEvent?.(event);
  };

  return {
    registerWait(wait) {
      return waitRegistry.register(wait);
    },
    observe(threadId, status, pendingExternalWait, archived, operatorWait) {
      return enqueue(async () => {
        const context = await readWaitContext(options.readLanes(), { threadId, status, archived: archived ?? false });
        await emitWaitEvents(context);
        await observeNow(threadId, status, pendingExternalWait, archived, operatorWait, undefined, context);
        await observeRoleNow(threadId, undefined, context);
        for (const event of context.events) {
          if (event.waiterThreadId === threadId || !options.readWorker) continue;
          try {
            const observation = await options.readWorker(event.waiterThreadId);
            await observeNow(event.waiterThreadId, observation.status, observation.pendingExternalWait, observation.archived, observation.operatorWait, observation.operatorWaitKnown, context);
            await observeRoleNow(event.waiterThreadId, undefined, context);
          } catch {
            // An unreadable waiter cannot be safely woken.
          }
        }
      });
    },
    poll() {
      return enqueue(async () => {
        const lanes = options.readLanes();
        clearResolved(lanes);
        const context = await readWaitContext(lanes);
        await emitWaitEvents(context);
        if (!options.readWorker) return;

        const workerIds = new Set(
          lanes
            .filter((lane) => OPEN_ATTEMPT_STATES.has(lane.attempt_state) && lane.thread_id)
            .map((lane) => lane.thread_id as string),
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
            context,
          );
        }

        if (options.readRoleHolders) {
          const roleThreadIds = new Set(options.readRoleHolders()
            .map((holder) => holder.thread_id));
          let roleScopes: RoleQueueScope[] | null = null;
          if (roleThreadIds.size > 0 && options.readRoleScopes) {
            try {
              roleScopes = await options.readRoleScopes();
            } catch {
              roleScopes = null;
            }
          }
          if (roleScopes) {
            for (const threadId of roleThreadIds) await observeRoleNow(threadId, roleScopes, context);
          }
        }
      });
    },
    wakeRole(role) {
      return enqueue(() => wakeRoleNow(role));
    },
    recover() {
      return enqueue(async () => {
        await continuationLedger.recover();
        await waitRegistry.recover();
        await operatorWaitAlertLedger.recover();
        await roleIdleLedger.recover();
      });
    },
    readRoleIdle(key) {
      return roleIdleLedger.get(key);
    },
    observeRoleIdle(key, idleSinceMs) {
      return roleIdleLedger.observeIdle(key, idleSinceMs);
    },
    resetRoleIdle(key) {
      return roleIdleLedger.resetIdle(key);
    },
    recordRoleWake(key, sentAtMs) {
      return roleIdleLedger.recordFleetWake(key, sentAtMs);
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
