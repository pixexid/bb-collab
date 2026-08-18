import type { SqliteDatabase } from "./foundation.js";

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
