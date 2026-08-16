// Registered waits (#93 / #57 mechanism 8): every "waiting for X" is a
// durable row with a mandatory deadline, written by the WAITER through the
// sanctioned CLI seam at the moment it decides to wait, and validated by a
// model-free read-only cycle. The validator never writes canonical SQLite
// tables, never creates receipts, and never becomes a second authority
// store: wait rows, fired-wake dedupe and escalation state live in the
// existing plugin KV seam. Host supervision (launchd KeepAlive) runs the
// same cycle through `bb collab wait-validator --cycle`; see
// docs/issue-93-durable-wait-validator.md.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const WAIT_EVENT_TYPES = ["source_terminal", "operator_response", "external_event"] as const;
export type WaitEventType = (typeof WAIT_EVENT_TYPES)[number];

// Default deadlines per wait type. An override is allowed but must carry a
// reason; no wait is ever registered without a concrete bounded deadline.
export const DEFAULT_WAIT_DEADLINES_MS: Readonly<Record<WaitEventType, number>> = {
  source_terminal: 8 * 60 * 60_000,
  operator_response: 4 * 60 * 60_000,
  external_event: 24 * 60 * 60_000,
};
export const MAX_WAIT_DEADLINE_MS = 7 * 24 * 60 * 60_000;
export const MAX_ACTIVE_WAITS = 128;
export const MAX_TERMINAL_WAIT_HISTORY = 256;
export const MAX_WAIT_STEERS = 2;
export const WAIT_STEER_GRACE_MS = 5 * 60_000;
export const WAIT_ESCALATION_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const LIVENESS_STALE_MS = 5 * 60_000;
export const THREAD_STATUSES: ReadonlySet<string> = new Set(["active", "idle", "error", "starting", "stopping"]);

export const WAIT_REGISTRY_KV_KEY = "wait-registry.waits";
export const WAIT_ESCALATION_KV_KEY = "wait-registry.escalation";
export const LIVENESS_MARKER_FILENAME = "wait-validator.liveness";
export const LIVENESS_ALERT_FLAG_FILENAME = "wait-validator.alerted";

export function waitValidatorStateDir(): string {
  return process.env.BB_COLLAB_VALIDATOR_STATE_DIR ?? join(homedir(), ".bb", "bb-collab");
}

export interface RegisteredWait {
  waitId: string;
  projectId: string;
  waiterThreadId: string;
  eventType: WaitEventType;
  sourceThreadId: string | null;
  reason: string;
  overrideReason: string | null;
  deadlineMs: number;
  createdAtMs: number;
  idempotencyKey: string;
}

export type TerminalWaitOutcome = "fired" | "cancelled";

export interface TerminalWaitRecord {
  waitId: string;
  projectId: string;
  waiterThreadId: string;
  outcome: TerminalWaitOutcome;
  reason: string | null;
  detail: string | null;
  endedAtMs: number;
}

export interface WaitRegistryState {
  active: RegisteredWait[];
  terminal: TerminalWaitRecord[];
}

export interface WaitRegistryPersistence {
  read(): Promise<unknown>;
  write(state: WaitRegistryState): Promise<void>;
}

export interface WaitSteerRecord {
  waitId: string;
  projectId: string;
  waiterThreadId: string;
  reason: WaitFireReason;
  detail: string | null;
  firedAtMs: number;
  steers: number;
  failedSteers: number;
  lastSteerAtMs: number | null;
  delivered: boolean;
  escalated: boolean;
}

export interface WaitEscalationPersistence {
  read(): Promise<unknown>;
  write(state: Record<string, WaitSteerRecord>): Promise<void>;
}

/** `null` means the source's liveness could not be proven; that is fail-closed. */
export type SourceObservation = { status: string; archived: boolean } | null;

export type RegisterWaitResult =
  | { outcome: "registered"; wait: RegisteredWait; replay: boolean }
  | { outcome: "refused"; message: string };

export type CancelWaitResult =
  | { outcome: "cancelled"; waitId: string }
  | { outcome: "refused"; message: string };

export interface WaitCycleSummary {
  outcome: "OK";
  subject: "wait-validator";
  evaluated: number;
  held: number;
  fired: number;
  steered: number;
  escalated: number;
  alerts: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function waitIdFor(projectId: string, idempotencyKey: string): string {
  return createHash("sha256").update(`${projectId}\n${idempotencyKey}`).digest("hex").slice(0, 40);
}

function parseRegisteredWait(value: unknown): RegisteredWait {
  if (!isPlainObject(value)) throw new Error("invalid registered wait");
  const {
    waitId, projectId, waiterThreadId, eventType, sourceThreadId,
    reason, overrideReason, deadlineMs, createdAtMs, idempotencyKey,
  } = value;
  if (
    !nonEmptyString(waitId, 64) || !nonEmptyString(projectId) || !nonEmptyString(waiterThreadId) ||
    !(WAIT_EVENT_TYPES as readonly string[]).includes(eventType as string) ||
    !(sourceThreadId === null || nonEmptyString(sourceThreadId)) ||
    !nonEmptyString(reason, 2048) || !(overrideReason === null || nonEmptyString(overrideReason, 2048)) ||
    !Number.isInteger(deadlineMs) || (deadlineMs as number) <= 0 ||
    !Number.isInteger(createdAtMs) || (createdAtMs as number) < 0 ||
    !nonEmptyString(idempotencyKey, 256)
  ) throw new Error("invalid registered wait");
  return {
    waitId: waitId as string,
    projectId: projectId as string,
    waiterThreadId: waiterThreadId as string,
    eventType: eventType as WaitEventType,
    sourceThreadId: sourceThreadId as string | null,
    reason: reason as string,
    overrideReason: overrideReason as string | null,
    deadlineMs: deadlineMs as number,
    createdAtMs: createdAtMs as number,
    idempotencyKey: idempotencyKey as string,
  };
}

function parseTerminalWait(value: unknown): TerminalWaitRecord {
  if (!isPlainObject(value)) throw new Error("invalid terminal wait record");
  const { waitId, projectId, waiterThreadId, outcome, reason, detail, endedAtMs } = value;
  if (
    !nonEmptyString(waitId, 64) || !nonEmptyString(projectId) || !nonEmptyString(waiterThreadId) ||
    (outcome !== "fired" && outcome !== "cancelled") ||
    !(reason === null || nonEmptyString(reason, 64)) || !(detail === null || nonEmptyString(detail, 256)) ||
    !Number.isInteger(endedAtMs) || (endedAtMs as number) < 0
  ) throw new Error("invalid terminal wait record");
  return {
    waitId: waitId as string,
    projectId: projectId as string,
    waiterThreadId: waiterThreadId as string,
    outcome: outcome as TerminalWaitOutcome,
    reason: reason as string | null,
    detail: detail as string | null,
    endedAtMs: endedAtMs as number,
  };
}

export function waitRegistryState(input: unknown): WaitRegistryState {
  if (!isPlainObject(input)) {
    if (input === undefined || input === null) return { active: [], terminal: [] };
    throw new Error("invalid wait registry state");
  }
  if (!Array.isArray(input.active) || !Array.isArray(input.terminal)) throw new Error("invalid wait registry state");
  return {
    active: input.active.map(parseRegisteredWait),
    terminal: input.terminal.map(parseTerminalWait),
  };
}

function parseWaitSteerRecord(value: unknown): WaitSteerRecord {
  if (!isPlainObject(value)) throw new Error("invalid wait escalation state");
  const {
    waitId, projectId, waiterThreadId, reason, detail, firedAtMs,
    steers, failedSteers, lastSteerAtMs, delivered, escalated,
  } = value;
  if (
    !nonEmptyString(waitId, 64) || !nonEmptyString(projectId) || !nonEmptyString(waiterThreadId) ||
    (reason !== "source_terminal" && reason !== "deadline_exceeded") ||
    !(detail === null || nonEmptyString(detail, 256)) ||
    !Number.isInteger(firedAtMs) || (firedAtMs as number) < 0 ||
    !Number.isInteger(steers) || (steers as number) < 0 || (steers as number) > MAX_WAIT_STEERS ||
    !Number.isInteger(failedSteers) || (failedSteers as number) < 0 || (failedSteers as number) > MAX_WAIT_STEERS ||
    !(lastSteerAtMs === null || (Number.isInteger(lastSteerAtMs) && (lastSteerAtMs as number) >= 0)) ||
    typeof delivered !== "boolean" || typeof escalated !== "boolean" ||
    (escalated as boolean) && (steers as number) < MAX_WAIT_STEERS && !(failedSteers === MAX_WAIT_STEERS)
  ) throw new Error("invalid wait escalation state");
  return {
    waitId: waitId as string,
    projectId: projectId as string,
    waiterThreadId: waiterThreadId as string,
    reason: reason as WaitFireReason,
    detail: detail as string | null,
    firedAtMs: firedAtMs as number,
    steers: steers as number,
    failedSteers: failedSteers as number,
    lastSteerAtMs: lastSteerAtMs as number | null,
    delivered: delivered as boolean,
    escalated: escalated as boolean,
  };
}

export function waitEscalationState(input: unknown): Record<string, WaitSteerRecord> {
  if (!isPlainObject(input)) {
    if (input === undefined || input === null) return {};
    throw new Error("invalid wait escalation state");
  }
  const state: Record<string, WaitSteerRecord> = {};
  for (const [key, value] of Object.entries(input)) state[key] = parseWaitSteerRecord(value);
  return state;
}

/**
 * A wait without a deadline is illegal. The deadline is either an explicit
 * bounded override (which must carry a reason) or the type default; anything
 * else — unknown type, explicit null, non-integer, in the past, or beyond the
 * horizon — is refused at registration, fail closed.
 */
export function resolveWaitDeadline(input: {
  eventType: unknown;
  deadlineMs: unknown;
  overrideReason: unknown;
  now: number;
}): { ok: true; deadlineMs: number; overrideReason: string | null } | { ok: false; message: string } {
  const defaults = DEFAULT_WAIT_DEADLINES_MS[input.eventType as WaitEventType];
  if (input.deadlineMs === undefined) {
    if (defaults === undefined) return { ok: false, message: "wait has no deadline: unknown event type has no default deadline" };
    return { ok: true, deadlineMs: input.now + defaults, overrideReason: null };
  }
  if (input.deadlineMs === null) return { ok: false, message: "wait without a deadline is refused: every wait must be bounded" };
  if (typeof input.deadlineMs !== "number" || !Number.isInteger(input.deadlineMs)) {
    return { ok: false, message: "wait deadline must be an integer millisecond timestamp" };
  }
  if (input.deadlineMs <= input.now) return { ok: false, message: "wait deadline must be in the future" };
  if (input.deadlineMs > input.now + MAX_WAIT_DEADLINE_MS) {
    return { ok: false, message: `wait deadline exceeds the ${MAX_WAIT_DEADLINE_MS}ms horizon` };
  }
  if (!nonEmptyString(input.overrideReason, 2048)) {
    return { ok: false, message: "an explicit wait deadline override requires a reason" };
  }
  return { ok: true, deadlineMs: input.deadlineMs, overrideReason: input.overrideReason };
}

function sameWaitBinding(left: RegisteredWait, right: Pick<RegisteredWait, "projectId" | "waiterThreadId" | "eventType" | "sourceThreadId" | "idempotencyKey">): boolean {
  return left.projectId === right.projectId &&
    left.waiterThreadId === right.waiterThreadId &&
    left.eventType === right.eventType &&
    left.sourceThreadId === right.sourceThreadId &&
    left.idempotencyKey === right.idempotencyKey;
}

export interface WaitRegistry {
  recover(): Promise<void>;
  register(input: unknown, ctxThreadId?: string): Promise<RegisterWaitResult>;
  cancel(input: unknown, ctxThreadId?: string): Promise<CancelWaitResult>;
  list(): Promise<WaitRegistryState>;
  activeWaitsFor(threadId: string): Promise<RegisteredWait[]>;
  activeWaiterThreadIds(): Promise<Set<string>>;
  /** Idempotent active→terminal transition; false when the wait is not active. */
  terminalizeWait(waitId: string, outcome: TerminalWaitOutcome, reason: string | null, detail: string | null): Promise<boolean>;
}

export function createWaitRegistry(options: {
  persistence?: WaitRegistryPersistence;
  readSource?: (threadId: string) => Promise<SourceObservation>;
  now?: () => number;
  maxActive?: number;
}): WaitRegistry {
  const now = options.now ?? Date.now;
  const maxActive = Number.isInteger(options.maxActive) && (options.maxActive ?? 0) > 0 ? options.maxActive as number : MAX_ACTIVE_WAITS;
  let state: WaitRegistryState | null = null;
  let queue = Promise.resolve();

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const loaded = async (): Promise<WaitRegistryState> => {
    if (!state) state = waitRegistryState(options.persistence ? await options.persistence.read() : null);
    return state;
  };
  const save = async () => {
    if (options.persistence && state) await options.persistence.write(structuredClone(state));
  };

  const terminalizeWait = async (
    waitId: string,
    outcome: TerminalWaitOutcome,
    reason: string | null,
    detail: string | null,
  ): Promise<boolean> => {
    const current = await loaded();
    const index = current.active.findIndex((candidate) => candidate.waitId === waitId);
    if (index < 0) return false;
    const wait = current.active[index];
    current.active.splice(index, 1);
    current.terminal.push({
      waitId: wait.waitId,
      projectId: wait.projectId,
      waiterThreadId: wait.waiterThreadId,
      outcome,
      reason,
      detail,
      endedAtMs: now(),
    });
    if (current.terminal.length > MAX_TERMINAL_WAIT_HISTORY) {
      current.terminal.splice(0, current.terminal.length - MAX_TERMINAL_WAIT_HISTORY);
    }
    await save();
    return true;
  };

  return {
    recover: () => enqueue(async () => { await loaded(); }),
    register: (input, ctxThreadId) => enqueue(async () => {
      if (!isPlainObject(input)) return { outcome: "refused", message: "wait registration must be a JSON object" };
      const current = await loaded();
      const projectId = nonEmptyString(input.projectId) ? input.projectId as string : null;
      if (!projectId) return { outcome: "refused", message: "projectId is required" };
      if (!nonEmptyString(input.idempotencyKey)) return { outcome: "refused", message: "idempotencyKey is required" };
      let waiterThreadId = nonEmptyString(input.waiterThreadId) ? input.waiterThreadId as string : null;
      if (ctxThreadId !== undefined) {
        if (waiterThreadId !== null && waiterThreadId !== ctxThreadId) {
          return { outcome: "refused", message: "waiterThreadId does not match the calling thread" };
        }
        waiterThreadId = ctxThreadId;
      }
      if (!waiterThreadId) return { outcome: "refused", message: "waiterThreadId is required" };
      const eventType = input.eventType;
      if (!(WAIT_EVENT_TYPES as readonly string[]).includes(eventType as string)) {
        return { outcome: "refused", message: `eventType must be one of ${WAIT_EVENT_TYPES.join(", ")}` };
      }
      if (!nonEmptyString(input.reason, 2048)) return { outcome: "refused", message: "reason is required: name what the wait is waiting for" };
      let sourceThreadId: string | null = optionalString(input.sourceThreadId);
      if (eventType === "source_terminal") {
        if (!sourceThreadId) return { outcome: "refused", message: "source_terminal waits require sourceThreadId" };
      } else if (sourceThreadId !== null) {
        return { outcome: "refused", message: "only source_terminal waits carry sourceThreadId" };
      }

      const deadline = resolveWaitDeadline({
        eventType,
        deadlineMs: input.deadlineMs === null ? null : input.deadlineMs,
        overrideReason: input.overrideReason,
        now: now(),
      });
      if (!deadline.ok) return { outcome: "refused", message: deadline.message };

      const waitId = waitIdFor(projectId, input.idempotencyKey as string);
      const activeMatch = current.active.find((candidate) => candidate.waitId === waitId) ?? null;
      if (activeMatch) {
        return sameWaitBinding(activeMatch, {
          projectId,
          waiterThreadId,
          eventType: eventType as WaitEventType,
          sourceThreadId,
          idempotencyKey: input.idempotencyKey as string,
        })
          ? { outcome: "registered", wait: structuredClone(activeMatch), replay: true }
          : { outcome: "refused", message: "idempotency key is already bound to a different wait" };
      }
      if (current.terminal.some((record) => record.waitId === waitId)) {
        return { outcome: "refused", message: "idempotency key was already consumed by a terminal wait" };
      }
      if (current.active.length >= maxActive) {
        return { outcome: "refused", message: `wait registry is full: at most ${maxActive} active waits` };
      }

      if (eventType === "source_terminal") {
        if (!options.readSource) return { outcome: "refused", message: "source liveness cannot be verified" };
        let observation: SourceObservation;
        try {
          observation = await options.readSource(sourceThreadId as string);
        } catch {
          observation = null;
        }
        if (observation === null) return { outcome: "refused", message: `source thread ${sourceThreadId} is unknown: waits on an unverifiable source are refused` };
        if (observation.archived) return { outcome: "refused", message: `source thread ${sourceThreadId} is already archived: act on its outcome instead of waiting` };
        if (!THREAD_STATUSES.has(observation.status)) return { outcome: "refused", message: `source thread ${sourceThreadId} has unknown status ${String(observation.status)}` };
        if (observation.status === "error") return { outcome: "refused", message: `source thread ${sourceThreadId} has already failed: act on its failure instead of waiting` };
      }

      const wait: RegisteredWait = {
        waitId,
        projectId,
        waiterThreadId,
        eventType: eventType as WaitEventType,
        sourceThreadId,
        reason: input.reason as string,
        overrideReason: deadline.overrideReason,
        deadlineMs: deadline.deadlineMs,
        createdAtMs: now(),
        idempotencyKey: input.idempotencyKey as string,
      };
      current.active.push(wait);
      await save();
      return { outcome: "registered", wait: structuredClone(wait), replay: false };
    }),
    cancel: (input, ctxThreadId) => enqueue(async () => {
      if (!isPlainObject(input)) return { outcome: "refused", message: "wait cancellation must be a JSON object" };
      const current = await loaded();
      const projectId = nonEmptyString(input.projectId) ? input.projectId as string : null;
      const waitId = nonEmptyString(input.waitId, 64) ? input.waitId as string : null;
      if (!projectId || !waitId) return { outcome: "refused", message: "projectId and waitId are required" };
      const index = current.active.findIndex((candidate) => candidate.projectId === projectId && candidate.waitId === waitId);
      if (index < 0) return { outcome: "refused", message: "unknown waitId for this project" };
      const wait = current.active[index];
      if (ctxThreadId !== undefined && ctxThreadId !== wait.waiterThreadId) {
        return { outcome: "refused", message: "only the waiter thread may cancel its registered wait" };
      }
      current.active.splice(index, 1);
      current.terminal.push({
        waitId: wait.waitId,
        projectId: wait.projectId,
        waiterThreadId: wait.waiterThreadId,
        outcome: "cancelled",
        reason: null,
        detail: null,
        endedAtMs: now(),
      });
      if (current.terminal.length > MAX_TERMINAL_WAIT_HISTORY) {
        current.terminal.splice(0, current.terminal.length - MAX_TERMINAL_WAIT_HISTORY);
      }
      await save();
      return { outcome: "cancelled", waitId: wait.waitId };
    }),
    list: () => enqueue(async () => structuredClone(await loaded())),
    activeWaitsFor: (threadId) => enqueue(async () =>
      (await loaded()).active.filter((wait) => wait.waiterThreadId === threadId).map((wait) => structuredClone(wait))),
    activeWaiterThreadIds: () => enqueue(async () =>
      new Set((await loaded()).active.map((wait) => wait.waiterThreadId))),
    terminalizeWait: (waitId, outcome, reason, detail) => enqueue(() => terminalizeWait(waitId, outcome, reason, detail)),
  };
}

export type WaitFireReason = "source_terminal" | "deadline_exceeded";

/**
 * Pure, model-free wait evaluation. A wait fires when its source reached a
 * terminal-ish state (error, archived, or a terminal attempt/receipt) or its
 * deadline passed. A source whose liveness cannot be proven is held, never
 * fired: the deadline remains the bound.
 */
export function evaluateRegisteredWaits(
  waits: readonly RegisteredWait[],
  sources: ReadonlyMap<string, SourceObservation>,
  sourceTerminals: ReadonlyMap<string, string>,
  now: number,
): Array<{ wait: RegisteredWait; reason: WaitFireReason; detail: string }> {
  const fires: Array<{ wait: RegisteredWait; reason: WaitFireReason; detail: string }> = [];
  for (const wait of waits) {
    if (wait.eventType === "source_terminal" && wait.sourceThreadId !== null) {
      const observation = sources.get(wait.sourceThreadId) ?? null;
      // Unknown liveness is not a fire condition, but it never disables the
      // deadline bound below: the deadline covers everything terminal-less.
      if (observation !== null) {
        if (observation.archived) {
          fires.push({ wait, reason: "source_terminal", detail: "source archived" });
          continue;
        }
        if (observation.status === "error") {
          fires.push({ wait, reason: "source_terminal", detail: "source error" });
          continue;
        }
        const laneTerminal = sourceTerminals.get(wait.sourceThreadId);
        if (laneTerminal !== undefined) {
          fires.push({ wait, reason: "source_terminal", detail: laneTerminal });
          continue;
        }
      }
    }
    if (now >= wait.deadlineMs) fires.push({ wait, reason: "deadline_exceeded", detail: `deadline ${wait.deadlineMs}` });
  }
  return fires;
}

export type LivenessState = "fresh" | "stale" | "missing";
export type LivenessDecision = "silent" | "alert-once" | "clear-alert-flag";

export function livenessState(markerAtMs: number | null, now: number, staleMs: number = LIVENESS_STALE_MS): LivenessState {
  if (markerAtMs === null || !Number.isFinite(markerAtMs)) return "missing";
  return now - markerAtMs >= staleMs ? "stale" : "fresh";
}

/**
 * The self-watch fires exactly once per staleness episode. A missing marker
 * is never launchd-failure evidence (the agent may simply not be deployed),
 * so it stays silent: fail closed against false operator alarms.
 */
export function livenessDecision(state: LivenessState, alerted: boolean): LivenessDecision {
  if (state === "fresh") return alerted ? "clear-alert-flag" : "silent";
  if (state === "stale") return alerted ? "silent" : "alert-once";
  return "silent";
}

export interface WaitValidator {
  recover(): Promise<void>;
  cycle(): Promise<WaitCycleSummary>;
}

/**
 * One model-free validation cycle. Reads waits and thread states, fires
 * terminalized sources and expired deadlines exactly once (KV dedupe),
 * steers the waiter through the sanctioned agent-only seam, and escalates
 * at most twice before a single operator alert plus succession trigger.
 * Restarts neither re-fire nor forget: every step is persisted before the
 * next one runs.
 */
export function createWaitValidator(options: {
  registry: WaitRegistry;
  escalationPersistence?: WaitEscalationPersistence;
  readSource: (threadId: string) => Promise<SourceObservation>;
  readWaiter: (threadId: string) => Promise<SourceObservation>;
  readSourceTerminals: () => Map<string, string>;
  steerWaiter: (record: { waitId: string; waiterThreadId: string; reason: WaitFireReason; detail: string | null }) => Promise<void>;
  onFire?: (record: { waitId: string; waiterThreadId: string; reason: WaitFireReason; detail: string | null }) => void;
  onEscalate?: (record: WaitSteerRecord) => void;
  now?: () => number;
  graceMs?: number;
  maxSteers?: number;
}): WaitValidator {
  const now = options.now ?? Date.now;
  const graceMs = Number.isInteger(options.graceMs) && (options.graceMs ?? 0) >= 0 ? options.graceMs as number : WAIT_STEER_GRACE_MS;
  const maxSteers = Number.isInteger(options.maxSteers) && (options.maxSteers ?? 0) > 0 ? options.maxSteers as number : MAX_WAIT_STEERS;
  let escalations: Record<string, WaitSteerRecord> | null = null;
  let queue = Promise.resolve();

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const loaded = async () => {
    if (!escalations) escalations = waitEscalationState(options.escalationPersistence ? await options.escalationPersistence.read() : null);
    return escalations;
  };
  const save = async () => {
    if (options.escalationPersistence && escalations) await options.escalationPersistence.write(structuredClone(escalations));
  };

  const observeSource = async (threadId: string): Promise<SourceObservation> => {
    try {
      return await options.readSource(threadId);
    } catch {
      return null;
    }
  };

  return {
    recover: () => enqueue(async () => { await loaded(); }),
    cycle: () => enqueue(async (): Promise<WaitCycleSummary> => {
      const currentNow = now();
      const registry = await options.registry.list();
      const summary: WaitCycleSummary = {
        outcome: "OK", subject: "wait-validator",
        evaluated: registry.active.length, held: registry.active.length, fired: 0, steered: 0, escalated: 0, alerts: 0,
      };
      const records = await loaded();

      const sourceIds = new Set(
        registry.active
          .filter((wait) => wait.eventType === "source_terminal" && wait.sourceThreadId !== null)
          .map((wait) => wait.sourceThreadId as string),
      );
      const sources = new Map<string, SourceObservation>();
      for (const sourceId of sourceIds) sources.set(sourceId, await observeSource(sourceId));
      const sourceTerminals = options.readSourceTerminals();

      for (const fire of evaluateRegisteredWaits(registry.active, sources, sourceTerminals, currentNow)) {
        if (records[fire.wait.waitId]) continue; // already fired: KV dedupe across restarts
        const record: WaitSteerRecord = {
          waitId: fire.wait.waitId,
          projectId: fire.wait.projectId,
          waiterThreadId: fire.wait.waiterThreadId,
          reason: fire.reason,
          detail: fire.detail,
          firedAtMs: currentNow,
          steers: 0,
          failedSteers: 0,
          lastSteerAtMs: null,
          delivered: false,
          escalated: false,
        };
        records[record.waitId] = record;
        await save();
        const terminalized = await options.registry.terminalizeWait(fire.wait.waitId, "fired", fire.reason, fire.detail);
        if (!terminalized) continue; // raced to terminal (cancel): no wake, no double count
        summary.held -= 1;
        summary.fired += 1;
        summary.alerts += 1;
        options.onFire?.(record);
      }

      for (const record of Object.values(records)) {
        if (currentNow - record.firedAtMs > WAIT_ESCALATION_RETENTION_MS) {
          delete records[record.waitId];
          await save();
          continue;
        }
        if (record.delivered || record.escalated) continue;
        let observation: SourceObservation;
        try {
          observation = await options.readWaiter(record.waiterThreadId);
        } catch {
          continue; // unknown waiter state is not evidence to steer or escalate
        }
        if (observation === null) continue;
        if (observation.status === "active") {
          record.delivered = true;
          await save();
          continue;
        }
        const steerAgeMs = record.lastSteerAtMs === null ? Number.POSITIVE_INFINITY : currentNow - record.lastSteerAtMs;
        if (steerAgeMs < graceMs) continue;
        if (record.steers >= maxSteers) {
          record.escalated = true;
          await save();
          summary.escalated += 1;
          summary.alerts += 1;
          options.onEscalate?.(record);
          continue;
        }
        let failed = false;
        try {
          await options.steerWaiter(record);
        } catch {
          failed = true; // a failed send is a failed steer; the second failure escalates
        }
        record.steers = Math.min(maxSteers, record.steers + 1);
        if (failed) record.failedSteers = Math.min(maxSteers, record.failedSteers + 1);
        record.lastSteerAtMs = currentNow;
        await save();
        summary.steered += 1;
        if (record.steers >= maxSteers && record.failedSteers >= maxSteers) {
          record.escalated = true;
          await save();
          summary.escalated += 1;
          summary.alerts += 1;
          options.onEscalate?.(record);
        }
      }
      return summary;
    }),
  };
}
