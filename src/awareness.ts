import type { BbPluginApi, PluginThreadEventPayloads } from "@bb/plugin-sdk";
import type { SqliteDatabase } from "./foundation.js";

export const WRONGFUL_IDLE_THRESHOLD_MS = 10 * 60_000;

type ThreadStatus = PluginThreadEventPayloads["thread.active"]["thread"]["status"];

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
  domain_id?: string;
  role_generation: number;
  execution_attempt_id: string;
  thread_id: string;
}

export interface CurrentRoleBinding {
  roleId: string;
  domainId?: string;
  generation: number;
  executionAttemptId: string;
  threadId: string;
  generationEventType: string | null;
}

export type CurrentRoleBindingUnknownReason = "canonical-store-unavailable" | "canonical-store-unreadable" | "project-unknown";

export type CurrentRoleBindingRead =
  | { status: "known"; bindings: CurrentRoleBinding[] }
  | { status: "unknown"; reason: CurrentRoleBindingUnknownReason };

export type CurrentRoleBindingResolution =
  | { standing: "active"; binding: CurrentRoleBinding }
  | { standing: "unseated" }
  | { standing: "refused"; reason: "multiple-active-bindings" }
  | { standing: "unknown"; reason: CurrentRoleBindingUnknownReason };

function roleIdlePrefix(holder: RoleHolderState): string {
  return `${JSON.stringify([holder.project_id, holder.role_id, holder.domain_id ?? "default", holder.role_generation]).slice(0, -1)},`;
}

export function roleIdleKey(holder: RoleHolderState, queueHeadId: string): string {
  return `${roleIdlePrefix(holder)}${JSON.stringify(queueHeadId)}]`;
}

export interface RoleQueueScope {
  projectId: string;
  domainId?: string;
  nextStartable: boolean;
  queueHeadId: string | null;
  deferredReason: OperatorWait["reason"] | null;
}

export interface RoleIdleView {
  projectId: string;
  roleId: string;
  domainId?: string;
  roleGeneration: number;
  executionAttemptId: string;
  threadId: string;
  queueHeadId: string;
  idleAgeMs: number;
}

export type RoleWakeResult =
  | { attempted: true; delivered: boolean }
  | { attempted: false; delivered: false; refusal: "policy" | "error" };

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
  lastStaleWaitExternalRevision: string | null;
  lastStaleWaitWaker: string | null;
  lastOwedActWakeAtMs: number | null;
  lastEscalationAtMs: number | null;
}

export type LaneWatcherAlert = {
  kind: "wrongful_idle_fyi";
  lane: null;
  role: RoleIdleView;
  count: 2;
  max: 2;
};

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
    const lastStaleWaitExternalRevision = typeof record.lastStaleWaitExternalRevision === "string" ? record.lastStaleWaitExternalRevision : null;
    const lastStaleWaitWaker = typeof record.lastStaleWaitWaker === "string" ? record.lastStaleWaitWaker : null;
    const lastOwedActWakeAtMs = typeof record.lastOwedActWakeAtMs === "number" && Number.isFinite(record.lastOwedActWakeAtMs) ? record.lastOwedActWakeAtMs : null;
    const lastEscalationAtMs = typeof record.lastEscalationAtMs === "number" && Number.isFinite(record.lastEscalationAtMs) ? record.lastEscalationAtMs : null;
    if (!Number.isInteger(record.steerCount) || (record.steerCount as number) < 0 || (record.steerCount as number) > 2 || !Number.isInteger(failedSteers) || failedSteers < 0 || failedSteers > 2 || (idleSinceMs !== null && idleSinceMs < 0) || (lastSteerAtMs !== null && lastSteerAtMs < 0) || (lastFleetWakeAtMs !== null && lastFleetWakeAtMs < 0) || (lastRecoveryWakeAtMs !== null && lastRecoveryWakeAtMs < 0) || (lastStartableQueueWakeAtMs !== null && lastStartableQueueWakeAtMs < 0) || (lastStaleWaitWakeAtMs !== null && lastStaleWaitWakeAtMs < 0) || (lastOwedActWakeAtMs !== null && lastOwedActWakeAtMs < 0) || (lastEscalationAtMs !== null && lastEscalationAtMs < 0) || typeof record.escalated !== "boolean") {
      throw new Error("invalid role idle state");
    }
    state[key] = { steerCount: record.steerCount as number, failedSteers, escalated: record.escalated as boolean, idleSinceMs, lastSteerAtMs, awaitingSteerOutcome, lastFleetWakeAtMs, lastRecoveryWakeAtMs, lastStartableQueueWakeAtMs, lastStaleWaitWakeAtMs, lastStaleWaitExternalRevision, lastStaleWaitWaker, lastOwedActWakeAtMs, lastEscalationAtMs };
  }
  return state;
}

function emptyRoleIdleRecord(): RoleIdleRecord {
  return { steerCount: 0, failedSteers: 0, escalated: false, idleSinceMs: null, lastSteerAtMs: null, awaitingSteerOutcome: false, lastFleetWakeAtMs: null, lastRecoveryWakeAtMs: null, lastStartableQueueWakeAtMs: null, lastStaleWaitWakeAtMs: null, lastStaleWaitExternalRevision: null, lastStaleWaitWaker: null, lastOwedActWakeAtMs: null, lastEscalationAtMs: null };
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
      state[key] = { ...emptyRoleIdleRecord(), lastFleetWakeAtMs: record.lastFleetWakeAtMs, lastRecoveryWakeAtMs: record.lastRecoveryWakeAtMs, lastStartableQueueWakeAtMs: record.lastStartableQueueWakeAtMs, lastStaleWaitWakeAtMs: record.lastStaleWaitWakeAtMs, lastStaleWaitExternalRevision: record.lastStaleWaitExternalRevision, lastStaleWaitWaker: record.lastStaleWaitWaker, lastOwedActWakeAtMs: record.lastOwedActWakeAtMs, lastEscalationAtMs: record.lastEscalationAtMs };
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
    recordStaleWaitWake: (key: string, sentAtMs: number, externalRevision: string | null = null, waker: string | null = null) => enqueue(async () => {
      await load();
      const nextState = { ...state, [key]: { ...(state[key] ?? emptyRoleIdleRecord()), lastStaleWaitWakeAtMs: sentAtMs, lastStaleWaitExternalRevision: externalRevision, lastStaleWaitWaker: waker } };
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
      const encodedPrefix = prefix.endsWith(":")
        ? `${JSON.stringify([prefix.slice(0, -1)]).slice(0, -1)},`
        : prefix;
      for (const key of Object.keys(state)) if (key.startsWith(prefix) || key.startsWith(encodedPrefix)) state[key] = { ...state[key]!, idleSinceMs: null, lastFleetWakeAtMs: null, lastRecoveryWakeAtMs: null, lastStartableQueueWakeAtMs: null, lastStaleWaitWakeAtMs: null, lastStaleWaitExternalRevision: null, lastStaleWaitWaker: null, lastOwedActWakeAtMs: null, lastEscalationAtMs: null };
      await save();
    }),
  };
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
  poll(signal?: AbortSignal): Promise<void>;
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
  const hasDomainColumns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((column) => column.name === "domain_id");
  if (hasDomainColumns("execution_attempts") && hasDomainColumns("role_generation_heads") && hasDomainColumns("role_generations")) {
    return db
      .prepare(
      `SELECT attempts.project_id, attempts.role_id, attempts.domain_id, attempts.role_generation,
              attempts.execution_attempt_id, attempts.thread_id
       FROM execution_attempts AS attempts
       JOIN role_generation_heads AS heads
         ON heads.project_id = attempts.project_id
        AND heads.role_id = attempts.role_id
        AND heads.domain_id = attempts.domain_id
        AND heads.current_generation = attempts.role_generation
       JOIN role_generations AS generations
         ON generations.project_id = attempts.project_id
        AND generations.role_id = attempts.role_id
        AND generations.domain_id = attempts.domain_id
        AND generations.generation = attempts.role_generation
        AND generations.holder_execution_attempt_id = attempts.execution_attempt_id
       WHERE attempts.origin = 'role_holder'
         AND attempts.thread_id IS NOT NULL
         AND generations.status = 'active'
       ORDER BY attempts.project_id, attempts.role_id, attempts.domain_id, attempts.role_generation`,
      )
      .all() as RoleHolderState[];
  }
  return db
    .prepare(
      `SELECT attempts.project_id, attempts.role_id, 'default' AS domain_id, attempts.role_generation,
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

export function readCurrentRoleBindings(db: SqliteDatabase | null, projectId: string): CurrentRoleBindingRead {
  if (!db) return { status: "unknown", reason: "canonical-store-unavailable" };
  try {
    if (!db.prepare("SELECT 1 FROM project_config_heads WHERE project_id = ?").get(projectId)) {
      return { status: "unknown", reason: "project-unknown" };
    }
    return {
      status: "known",
      bindings: readRoleHolderStates(db)
        .filter((holder) => holder.project_id === projectId)
        .map((holder) => {
          const domainId = holder.domain_id ?? "default";
          const event = db.prepare(
            `SELECT event_type FROM state_events
             WHERE project_id = ? AND aggregate_type = 'role_generation' AND aggregate_id = ? AND aggregate_revision = ?
               AND (json_extract(event_json, '$.domainId') = ?
                 OR (? = 'default' AND json_extract(event_json, '$.domainId') IS NULL))
             ORDER BY event_sequence DESC LIMIT 1`,
          ).get(projectId, holder.role_id, holder.role_generation, domainId, domainId) as { event_type: string } | undefined;
          return {
            roleId: holder.role_id,
            domainId,
            generation: holder.role_generation,
            executionAttemptId: holder.execution_attempt_id,
            threadId: holder.thread_id,
            generationEventType: event?.event_type ?? null,
          };
        }),
    };
  } catch {
    return { status: "unknown", reason: "canonical-store-unreadable" };
  }
}

export function createLaneWatcher(options: {
  readWorker?: (threadId: string, signal?: AbortSignal) => Promise<WorkerObservation>;
  waitRegistry?: WaitRegistry;
  readRegisteredWaits?: () => RegisteredWait[] | Promise<RegisteredWait[]>;
  onWaitEvent?: (event: WaitEvent) => void | Promise<void>;
  readRoleHolders?: () => RoleHolderState[];
  readRoleScopes?: () => Promise<RoleQueueScope[]> | RoleQueueScope[];
  roleIdlePersistence?: RoleIdlePersistence;
  roleIdleThresholdMs?: number;
  steerRole?: (role: RoleIdleView) => Promise<boolean | void | "error">;
  onRoleSuccessionRequired?: (role: RoleIdleView) => void;
  now?: () => number;
  onAlert?: (alert: LaneWatcherAlert) => void;
}): LaneWatcher {
  const waitRegistry = options.waitRegistry ?? createWaitRegistry();
  const roleIdleLedger = createRoleIdleLedger(options.roleIdlePersistence);
  const roleIdleThresholdMs = Number.isInteger(options.roleIdleThresholdMs) && (options.roleIdleThresholdMs ?? 0) >= 0
    ? options.roleIdleThresholdMs as number
    : WRONGFUL_IDLE_THRESHOLD_MS;
  const now = options.now ?? Date.now;
  let queue = Promise.resolve();

  const readWaitContext = async (
    suppliedSource?: { threadId: string; status: ThreadStatus; archived: boolean },
    signal?: AbortSignal,
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
      let observation: WorkerObservation | null = null;
      if (suppliedSource?.threadId === sourceThreadId) {
        observation = {
          status: suppliedSource.status,
          pendingExternalWait: false,
          archived: suppliedSource.archived,
        };
      } else if (options.readWorker) {
        try {
          observation = signal ? await options.readWorker(sourceThreadId, signal) : await options.readWorker(sourceThreadId);
        } catch {
          observation = null;
        }
      }
      sourceStates.set(sourceThreadId, {
        known: observation !== null,
        terminal: observation?.archived === true || observation?.status === "error",
        failed: observation?.archived === true || observation?.status === "error",
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

  const roleAlert = (role: RoleIdleView) => {
    options.onAlert?.({ kind: "wrongful_idle_fyi", lane: null, role, count: 2, max: 2 });
  };

  const resolveCurrentCanonicalHolder = (holder: RoleHolderState): RoleHolderState | null | undefined => {
    if (!options.readRoleHolders) return null;
    try {
      const current = options.readRoleHolders().filter((candidate) =>
        candidate.project_id === holder.project_id && candidate.role_id === holder.role_id && (candidate.domain_id ?? "default") === (holder.domain_id ?? "default"),
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

  const observeRoleNow = async (threadId?: string, suppliedScopes?: RoleQueueScope[], waitContext?: WaitContext, signal?: AbortSignal): Promise<void> => {
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
      if (signal?.aborted) return;
      const projectHolders = holders.filter((candidate) => candidate.project_id === holder.project_id && candidate.role_id === holder.role_id && (candidate.domain_id ?? "default") === (holder.domain_id ?? "default"));
      if (projectHolders.length !== 1 || !holder.thread_id) continue;
      const targetThreadId = holder.thread_id;
      if (threadId && targetThreadId !== threadId) continue;
      const prefix = roleIdlePrefix(holder);
    const scope = scopes.find((candidate) => candidate.projectId === holder.project_id && (candidate.domainId ?? "default") === (holder.domain_id ?? "default"));
      let observation: WorkerObservation;
      try {
        observation = signal ? await options.readWorker(targetThreadId, signal) : await options.readWorker(targetThreadId);
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
            domainId: holder.domain_id ?? "default",
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
        domainId: holder.domain_id ?? "default",
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
      domain_id: role.domainId ?? "default",
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
    const scope = scopes.find((candidate) => candidate.projectId === role.projectId && (candidate.domainId ?? "default") === (role.domainId ?? "default"));
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

    const prefix = roleIdlePrefix(holder);
    const key = roleIdleKey(holder, scope.queueHeadId);
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

  const enqueue = <T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const result = queue.then(work);
    queue = result.then(() => undefined, () => undefined);
    if (!signal) return result;
    if (signal.aborted) return Promise.resolve(undefined as T);
    let onAbort!: () => void;
    const aborted = new Promise<T>((resolve) => {
      onAbort = () => resolve(undefined as T);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return Promise.race([result, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
  };

  const emitWaitEvents = async (context: WaitContext) => {
    for (const event of context.events) await options.onWaitEvent?.(event);
  };

  return {
    registerWait(wait) {
      return waitRegistry.register(wait);
    },
    observe(threadId, status, _pendingExternalWait, archived) {
      return enqueue(async () => {
        const context = await readWaitContext({ threadId, status, archived: archived ?? false });
        await emitWaitEvents(context);
        await observeRoleNow(threadId, undefined, context);
        for (const event of context.events) {
          if (event.waiterThreadId === threadId || !options.readWorker) continue;
          try {
            await observeRoleNow(event.waiterThreadId, undefined, context);
          } catch {
            // An unreadable waiter cannot be safely woken.
          }
        }
      });
    },
    poll(signal) {
      return enqueue(async () => {
        if (signal?.aborted) return;
        const context = await readWaitContext(undefined, signal);
        await emitWaitEvents(context);
        if (!options.readWorker) return;

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
            for (const threadId of roleThreadIds) {
              if (signal?.aborted) return;
              await observeRoleNow(threadId, roleScopes, context, signal);
            }
          }
        }
      }, signal);
    },
    wakeRole(role) {
      return enqueue(() => wakeRoleNow(role));
    },
    recover() {
      return enqueue(async () => {
        await waitRegistry.recover();
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
  observe: (threadId: string, status: ThreadStatus, archived?: boolean, projectId?: string, parentThreadId?: string | null) => Promise<void>,
): () => void {
  try {
    return sdk.subscribe({
      event: "thread:changed",
      callback: (event) => {
        if (event.entity !== "thread" || !event.id) return;
        void sdk.threads
          .get({ threadId: event.id })
          .then((thread) => thread.archivedAt === null && thread.deletedAt === null
            ? observe(thread.id, thread.status, false, thread.projectId, thread.parentThreadId)
            : observe(thread.id, thread.status, true, thread.projectId, thread.parentThreadId))
          .catch(() => undefined);
      },
    });
  } catch {
    // Isolated SDK test hosts may omit the optional realtime stub.
    return () => undefined;
  }
}

export const IDLE_FLEET_DEBOUNCE_MS = 2 * 60_000;

export interface IdleFleetProbe {
  projectId: string;
  threadId: string;
  idleEpisode: string;
}

export interface IdleFleetReady {
  probe: IdleFleetProbe;
  episodeKey: string;
  legacyEpisodeKey?: string;
  role: RoleIdleView;
  message: string;
}

export type IdleFleetDecision =
  | { kind: "silent" }
  | { kind: "blind"; message: string }
  | { kind: "ready"; episodeKey: string; legacyEpisodeKey?: string; role: RoleIdleView; message: string };

export interface IdleFleetPersistence {
  read(): Promise<unknown>;
  write(state: Record<string, string>): Promise<void>;
}

export interface IdleFleetCapacityRecorder {
  readProjectIds(): Promise<string[]>;
  observe(projectId: string): Promise<void>;
  close(): void;
}

function idleFleetWakeState(input: unknown): Record<string, string> {
  if (input === undefined || input === null) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid idle-fleet wake state");
  const state: Record<string, string> = {};
  for (const [projectId, episodeKey] of Object.entries(input)) {
    if (typeof episodeKey !== "string" || episodeKey.length === 0) throw new Error("invalid idle-fleet wake episode");
    state[projectId] = episodeKey;
  }
  return state;
}

export function createIdleFleetDetector(options: {
  read: (probe: IdleFleetProbe) => Promise<IdleFleetDecision>;
  readRearmProbes: () => Promise<IdleFleetProbe[]>;
  wake: (ready: IdleFleetReady) => Promise<boolean>;
  onBlind: (message: string) => void;
  persistence?: IdleFleetPersistence;
  capacity?: IdleFleetCapacityRecorder;
  debounceMs?: number;
}): {
  arm(probe: IdleFleetProbe): void;
  observeCapacity(projectId: string): Promise<void>;
  rearm(): Promise<void>;
  stop(): Promise<void>;
} {
  const debounceMs = Number.isInteger(options.debounceMs) && (options.debounceMs ?? 0) >= 0
    ? options.debounceMs as number
    : IDLE_FLEET_DEBOUNCE_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let state: Record<string, string> = {};
  let loaded = false;
  let stopped = false;
  const capacityQueues = new Map<string, Promise<void>>();
  const inFlightCapacityReads = new Set<Promise<void>>();
  let stopping: Promise<void> | undefined;
  const probeKey = (probe: IdleFleetProbe) => JSON.stringify([probe.projectId, probe.threadId]);
  const legacyProbeKey = (probe: IdleFleetProbe) => `${probe.projectId}:${probe.threadId}`;

  const load = async () => {
    if (loaded) return;
    state = idleFleetWakeState(options.persistence ? await options.persistence.read() : null);
    loaded = true;
  };
  let commitQueue = Promise.resolve();
  const pendingProjectChanges = new Map<string, Map<string, string | undefined>>();
  const keyBelongsToProject = (key: string, projectId: string) => {
    if (key.startsWith(`${projectId}:`)) return true;
    try {
      const parsed = JSON.parse(key) as unknown;
      return Array.isArray(parsed) && parsed[0] === projectId;
    } catch {
      return false;
    }
  };
  const applyChanges = (base: Record<string, string>, changes: ReadonlyMap<string, string | undefined>) => {
    const merged = structuredClone(base);
    for (const [key, value] of changes) {
      if (value === undefined) delete merged[key];
      else merged[key] = value;
    }
    return merged;
  };
  const flushPendingProject = async (projectId: string) => {
    const pending = pendingProjectChanges.get(projectId);
    if (!pending || pending.size === 0) return;
    const commit = commitQueue.then(async () => {
      const merged = applyChanges(state, pending);
      state = merged;
      await options.persistence?.write(merged);
      pendingProjectChanges.clear();
    });
    commitQueue = commit.then(() => undefined, () => undefined);
    await commit;
  };
  const commitProjectState = async (projectId: string, before: Record<string, string>, after: Record<string, string>) => {
    const changes = new Map<string, string | undefined>();
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!keyBelongsToProject(key, projectId) || before[key] === after[key]) continue;
      changes.set(key, after[key]);
    }
    if (changes.size === 0) return;
    const commit = commitQueue.then(async () => {
      const merged = applyChanges(state, changes);
      state = merged;
      try {
        await options.persistence?.write(merged);
        pendingProjectChanges.clear();
      } catch (error) {
        const pending = pendingProjectChanges.get(projectId) ?? new Map<string, string | undefined>();
        for (const [key, value] of changes) pending.set(key, value);
        pendingProjectChanges.set(projectId, pending);
        throw error;
      }
    });
    commitQueue = commit.then(() => undefined, () => undefined);
    await commit;
  };
  const blindReportIntervalMs = 1_000;
  let lastBlindMessage: string | null = null;
  let blindOccurrences = 0;
  let lastReportedOccurrences = 0;
  let lastBlindReportAt = 0;
  let blindCountCutShort = false;
  const emitBlind = (message: string, occurrences: number) => {
    try {
      options.onBlind(`${message} occurrences=${blindCountCutShort ? `>=${occurrences} (counting cut short)` : occurrences}`);
    } catch {
      // Coverage reporting cannot keep the detector from re-arming.
    }
  };
  const flushBlind = () => {
    if (lastBlindMessage !== null && blindOccurrences > lastReportedOccurrences) {
      emitBlind(lastBlindMessage, blindOccurrences);
    }
    lastBlindMessage = null;
    blindOccurrences = 0;
    lastReportedOccurrences = 0;
    lastBlindReportAt = 0;
    blindCountCutShort = false;
  };
  const reportBlind = (message: string, capacityRead = false) => {
    const marked = capacityRead && blindCountCutShort;
    const now = Date.now();
    if (message === lastBlindMessage) {
      blindOccurrences += 1;
      if (now - lastBlindReportAt < blindReportIntervalMs) return;
    } else {
      flushBlind();
      lastBlindMessage = message;
      blindOccurrences = 1;
      if (marked) blindCountCutShort = true;
    }
    lastBlindReportAt = now;
    lastReportedOccurrences = blindOccurrences;
    emitBlind(message, blindOccurrences);
  };

  const evaluate = async (probe: IdleFleetProbe) => {
    try {
      await load();
      await flushPendingProject(probe.projectId);
      const decision = await options.read(probe);
      const key = probeKey(probe);
      const before = structuredClone(state);
      const next = structuredClone(before);
      if (decision.kind === "silent") {
        if (next[key] !== undefined) {
          delete next[key];
          await commitProjectState(probe.projectId, before, next);
        }
        return;
      }
      if (decision.kind === "blind") {
        if (next[key] !== undefined) {
          delete next[key];
          await commitProjectState(probe.projectId, before, next);
        }
        reportBlind(decision.message);
        return;
      }
      const legacyKey = legacyProbeKey(probe);
      if (next[legacyKey] !== undefined) {
        if (next[key] !== undefined) {
          reportBlind(`idle-fleet coverage=blind orchestrator=blind activeLanes=blind startable=blind reason=ambiguous-migration:${key}`);
          return;
        }
        next[key] = next[legacyKey]!;
        delete next[legacyKey];
      }
      if (next[key] === decision.episodeKey) {
        await commitProjectState(probe.projectId, before, next);
        return;
      }
      if (decision.legacyEpisodeKey !== undefined && next[key] === decision.legacyEpisodeKey) {
        next[key] = decision.episodeKey;
        await commitProjectState(probe.projectId, before, next);
        return;
      }
      if (!await options.wake({ ...decision, probe })) return;
      next[key] = decision.episodeKey;
      await commitProjectState(probe.projectId, before, next);
    } catch (error) {
      reportBlind(`idle-fleet coverage=blind orchestrator=blind activeLanes=blind startable=blind reason=detector-unreadable:${String(error)}`);
    }
  };

  const evaluationQueues = new Map<string, Promise<void>>();
  const enqueueEvaluate = (probe: IdleFleetProbe) => {
    const previous = evaluationQueues.get(probe.projectId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => evaluate(probe));
    evaluationQueues.set(probe.projectId, current);
    void current.then(() => {
      if (evaluationQueues.get(probe.projectId) === current) evaluationQueues.delete(probe.projectId);
    }, () => {
      if (evaluationQueues.get(probe.projectId) === current) evaluationQueues.delete(probe.projectId);
    });
  };

  const arm = (probe: IdleFleetProbe) => {
    if (stopped) return;
    const key = probeKey(probe);
    const existing = timers.get(key);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(key);
      enqueueEvaluate(probe);
    }, debounceMs);
    timers.set(key, timer);
  };

  const observeCapacity = (projectId: string): Promise<void> => {
    if (stopped || !options.capacity) return Promise.resolve();
    const previous = capacityQueues.get(projectId) ?? Promise.resolve();
    const next = previous.then(() => {
      if (stopped) return;
      return options.capacity!.observe(projectId);
    });
    capacityQueues.set(projectId, next.catch(() => undefined));
    const read = next.catch((error) => {
      reportBlind(`idle-fleet coverage=blind orchestrator=blind activeLanes=blind startable=blind reason=capacity-interval-unreadable:${String(error)}`, true);
    });
    inFlightCapacityReads.add(read);
    void read.then(() => inFlightCapacityReads.delete(read));
    return read;
  };

  return {
    arm,
    observeCapacity,
    async rearm() {
      if (stopped) return;
      try {
        const probes = await options.readRearmProbes();
        for (const probe of probes) arm(probe);
        if (options.capacity) {
          for (const projectId of await options.capacity.readProjectIds()) await observeCapacity(projectId);
        }
      } catch (error) {
        reportBlind(`idle-fleet coverage=blind orchestrator=blind activeLanes=blind startable=blind reason=restart-rearm-unreadable:${String(error)}`);
      }
    },
    stop() {
      if (stopping) return stopping;
      stopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      try {
        options.capacity?.close();
      } catch (error) {
        reportBlind(`idle-fleet coverage=blind orchestrator=blind activeLanes=blind startable=blind reason=capacity-close-unreadable:${String(error)}`);
      }
      stopping = (async () => {
        const reads = [...inFlightCapacityReads];
        if (reads.length > 0) {
          let expired = true;
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 1_000);
            void Promise.allSettled(reads).then(() => {
              expired = false;
              clearTimeout(timeout);
              resolve();
            });
          });
          flushBlind();
          if (expired) blindCountCutShort = true;
        } else {
          flushBlind();
        }
      })();
      return stopping;
    },
  };
}
