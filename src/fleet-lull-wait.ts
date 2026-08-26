import type { SqliteDatabase } from "./foundation.js";

export const FLEET_LULL_WAIT_MAX_MS = 7 * 24 * 60 * 60_000;
export const FLEET_LULL_WAIT_KV_KEY = "fleet-lull.waits";

const NON_TERMINAL_ATTEMPT_STATES = ["prepared", "armed", "content_delivered", "running", "dispatch_unknown"] as const;

export type FleetLullPredicate = {
  outcome: "satisfied" | "unsatisfied" | "unknown";
  projectIds: string[];
  activeWorkerSeats: Array<{ projectId: string; executionAttemptId: string; threadId: string }>;
  nonInertAttempts: Array<{ projectId: string; executionAttemptId: string; threadId: string | null; leaseOwnerThreadId: string | null }>;
  liveLeases: Array<{ projectId: string; executionAttemptId: string; leaseOwnerThreadId: string }>;
  reason?: string;
};

export function readFleetLullPredicate(
  db: SqliteDatabase | null,
  excludedThreadId: string,
  now = Date.now(),
): FleetLullPredicate {
  if (!db) return { outcome: "unknown", projectIds: [], activeWorkerSeats: [], nonInertAttempts: [], liveLeases: [], reason: "canonical-store-unavailable" };
  try {
    const projectIds = (db.prepare("SELECT project_id FROM project_config_heads ORDER BY project_id").all() as Array<{ project_id: string }>).map(({ project_id }) => project_id);
    const placeholders = NON_TERMINAL_ATTEMPT_STATES.map(() => "?").join(", ");
    const activeWorkerSeats = db.prepare(
      `SELECT attempts.project_id, attempts.execution_attempt_id, attempts.thread_id
       FROM project_config_heads AS projects
       JOIN role_generation_heads AS heads ON heads.project_id = projects.project_id AND heads.role_id = 'worker'
       JOIN role_generations AS generations
         ON generations.project_id = heads.project_id AND generations.role_id = heads.role_id
        AND generations.domain_id = heads.domain_id AND generations.generation = heads.current_generation
       JOIN execution_attempts AS attempts
         ON attempts.project_id = generations.project_id AND attempts.execution_attempt_id = generations.holder_execution_attempt_id
        AND attempts.role_id = 'worker' AND attempts.origin = 'role_holder'
       WHERE generations.status = 'active' AND attempts.thread_id IS NOT NULL AND attempts.thread_id <> ?
       ORDER BY attempts.project_id, attempts.execution_attempt_id`,
    ).all(excludedThreadId) as Array<{ project_id: string; execution_attempt_id: string; thread_id: string }>;
    const nonInertAttempts = db.prepare(
      `SELECT attempts.project_id, attempts.execution_attempt_id, attempts.thread_id, attempts.lease_owner_thread_id
       FROM project_config_heads AS projects
       JOIN execution_attempts AS attempts ON attempts.project_id = projects.project_id
       WHERE attempts.state IN (${placeholders})
         AND NOT (attempts.thread_id = ? OR (attempts.thread_id IS NULL AND attempts.lease_owner_thread_id = ?))
         AND (attempts.thread_id IS NOT NULL OR attempts.lease_owner_thread_id IS NOT NULL)
       ORDER BY attempts.project_id, attempts.execution_attempt_id`,
    ).all(...NON_TERMINAL_ATTEMPT_STATES, excludedThreadId, excludedThreadId) as Array<{ project_id: string; execution_attempt_id: string; thread_id: string | null; lease_owner_thread_id: string | null }>;
    const liveLeases = db.prepare(
      `SELECT attempts.project_id, attempts.execution_attempt_id, attempts.lease_owner_thread_id
       FROM project_config_heads AS projects
       JOIN execution_attempts AS attempts ON attempts.project_id = projects.project_id
       WHERE attempts.lease_owner_thread_id IS NOT NULL
         AND attempts.lease_owner_thread_id <> ?
         AND (attempts.lease_expires_at_ms IS NULL OR attempts.lease_expires_at_ms > ?)
       ORDER BY attempts.project_id, attempts.execution_attempt_id`,
    ).all(excludedThreadId, now) as Array<{ project_id: string; execution_attempt_id: string; lease_owner_thread_id: string }>;
    return {
      outcome: activeWorkerSeats.length === 0 && nonInertAttempts.length === 0 && liveLeases.length === 0 ? "satisfied" : "unsatisfied",
      projectIds,
      activeWorkerSeats: activeWorkerSeats.map((row) => ({ projectId: row.project_id, executionAttemptId: row.execution_attempt_id, threadId: row.thread_id })),
      nonInertAttempts: nonInertAttempts.map((row) => ({ projectId: row.project_id, executionAttemptId: row.execution_attempt_id, threadId: row.thread_id, leaseOwnerThreadId: row.lease_owner_thread_id })),
      liveLeases: liveLeases.map((row) => ({ projectId: row.project_id, executionAttemptId: row.execution_attempt_id, leaseOwnerThreadId: row.lease_owner_thread_id })),
    };
  } catch (error) {
    return { outcome: "unknown", projectIds: [], activeWorkerSeats: [], nonInertAttempts: [], liveLeases: [], reason: `canonical-store-unreadable:${String(error)}` };
  }
}

export type FleetLullWait = {
  waitId: string;
  projectId: string;
  waiterThreadId: string;
  excludedThreadId: string;
  deadlineAtMs: number;
};

export type FleetLullWakeReason = "satisfied" | "timeout";

export type FleetLullWaitResult =
  | { outcome: "registered"; wait: FleetLullWait; replay: boolean }
  | { outcome: "already_satisfied"; wait: FleetLullWait; replay: boolean }
  | { outcome: "refused"; message: string };

export interface FleetLullWaitPersistence {
  read(): Promise<unknown>;
  write(state: { waits: FleetLullWait[]; fired: Record<string, FleetLullWakeReason> }): Promise<void>;
}

type State = { waits: FleetLullWait[]; fired: Record<string, FleetLullWakeReason> };

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function parseState(value: unknown): State {
  if (value === undefined || value === null) return { waits: [], fired: {} };
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("invalid fleet lull wait state");
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.waits) || typeof record.fired !== "object" || record.fired === null || Array.isArray(record.fired)) throw new Error("invalid fleet lull wait state");
  const waits = record.waits.map((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) throw new Error("invalid fleet lull wait");
    const wait = candidate as Record<string, unknown>;
    if (!validId(wait.waitId) || !validId(wait.projectId) || !validId(wait.waiterThreadId) || !validId(wait.excludedThreadId) || !Number.isSafeInteger(wait.deadlineAtMs)) throw new Error("invalid fleet lull wait");
    return { waitId: wait.waitId, projectId: wait.projectId, waiterThreadId: wait.waiterThreadId, excludedThreadId: wait.excludedThreadId, deadlineAtMs: wait.deadlineAtMs as number };
  });
  const fired: Record<string, FleetLullWakeReason> = {};
  for (const [waitId, reason] of Object.entries(record.fired)) {
    if (!waits.some((wait) => wait.waitId === waitId) || (reason !== "satisfied" && reason !== "timeout")) throw new Error("invalid fleet lull fired wait");
    fired[waitId] = reason;
  }
  return { waits, fired };
}

export function createFleetLullWaker(options: {
  db: SqliteDatabase | null;
  persistence: FleetLullWaitPersistence;
  validateWaiter?: (wait: FleetLullWait) => Promise<boolean>;
  wake: (wait: FleetLullWait, reason: FleetLullWakeReason) => Promise<void>;
  now?: () => number;
}) {
  let state: State = { waits: [], fired: {} };
  let loaded = false;
  let stopped = false;
  let queue = Promise.resolve();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const now = options.now ?? Date.now;
  const load = async () => {
    if (loaded) return;
    state = parseState(await options.persistence.read());
    loaded = true;
  };
  const save = () => options.persistence.write(structuredClone(state));
  const clearTimer = (waitId: string) => {
    const timer = timers.get(waitId);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(waitId);
  };
  const fire = async (wait: FleetLullWait, reason: FleetLullWakeReason) => {
    if (state.fired[wait.waitId]) return;
    state.fired[wait.waitId] = reason;
    clearTimer(wait.waitId);
    await save();
    await options.wake(wait, reason);
  };
  const evaluate = async (only?: FleetLullWait) => {
    await load();
    const waits = only ? [only] : state.waits;
    for (const wait of waits) {
      if (state.fired[wait.waitId] || now() >= wait.deadlineAtMs) {
        if (!state.fired[wait.waitId] && now() >= wait.deadlineAtMs) await fire(wait, "timeout");
        continue;
      }
      const predicate = readFleetLullPredicate(options.db, wait.excludedThreadId, now());
      if (predicate.outcome === "satisfied") await fire(wait, "satisfied");
    }
  };
  const armTimer = (wait: FleetLullWait) => {
    clearTimer(wait.waitId);
    timers.set(wait.waitId, setTimeout(() => {
      void enqueue(async () => {
        await load();
        const current = state.waits.find((candidate) => candidate.waitId === wait.waitId);
        if (current && !state.fired[current.waitId]) await fire(current, "timeout");
      }).catch(() => undefined);
    }, Math.max(1, wait.deadlineAtMs - now())));
  };
  return {
    recover: () => enqueue(async () => {
      await load();
      if (stopped) return;
      for (const wait of state.waits) if (!state.fired[wait.waitId]) armTimer(wait);
      await evaluate();
    }),
    register: (input: FleetLullWait): Promise<FleetLullWaitResult> => enqueue(async () => {
      await load();
      if (stopped) return { outcome: "refused", message: "fleet lull waker is stopped" };
      if (!validId(input.waitId) || !validId(input.projectId) || !validId(input.waiterThreadId) || !validId(input.excludedThreadId)) return { outcome: "refused", message: "fleet lull wait identity is required" };
      if (input.waiterThreadId !== input.excludedThreadId) return { outcome: "refused", message: "waiterThreadId and excludedThreadId must name the calling thread" };
      if (!Number.isSafeInteger(input.deadlineAtMs) || input.deadlineAtMs <= now() || input.deadlineAtMs > now() + FLEET_LULL_WAIT_MAX_MS) return { outcome: "refused", message: `fleet lull wait deadline must be in the next ${FLEET_LULL_WAIT_MAX_MS}ms` };
      if (options.validateWaiter && !await options.validateWaiter(input)) return { outcome: "refused", message: "waiter thread is unknown, foreign, archived, deleted, or not active/idle" };
      const existing = state.waits.find((wait) => wait.waitId === input.waitId);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(input)) return { outcome: "refused", message: "waitId is already bound to a different fleet lull wait" };
        if (state.fired[input.waitId]) return { outcome: "refused", message: "waitId was already consumed by a fleet lull wake" };
        return { outcome: "registered", wait: existing, replay: true };
      }
      state.waits.push(input);
      await save();
      armTimer(input);
      await evaluate(input);
      return state.fired[input.waitId] === "satisfied"
        ? { outcome: "already_satisfied", wait: input, replay: false }
        : { outcome: "registered", wait: input, replay: false };
    }),
    signal: () => enqueue(async () => {
      if (!stopped) await evaluate();
    }),
    stop: () => {
      stopped = true;
      for (const waitId of timers.keys()) clearTimer(waitId);
    },
  };
}
