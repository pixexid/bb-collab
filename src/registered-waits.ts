// Durable wait-validator layer (#93) on top of the #57 mechanism-8
// registered-wait substrate (PR #95, src/awareness.ts). The wait store is
// exactly one: the lane watcher's KV registry (`lane-watcher.registered-
// waits`), written by the waiter through the sanctioned seams. This module
// adds the operator-approved #93 requirements around that store — mandatory
// bounded deadlines with a default and override discipline, fail-closed
// source-liveness validation at registration, a bounded escalation ladder
// for fired waits (steer, then exactly one operator alert plus a succession
// trigger), and the host-supervised liveness rule. It never writes a
// canonical SQLite table, resolver, or receipt, and it creates no second
// authority store: waits and their fired state live in the one registry.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// Deadline law. The registry itself requires a deadline; this layer makes it
// mandatory with a default, bounded horizon, and override discipline.
export const DEFAULT_WAIT_DEADLINE_MS = 8 * 60 * 60_000; // source-terminal waits: one working shift
export const MAX_WAIT_DEADLINE_MS = 7 * 24 * 60 * 60_000; // hard horizon: no unbounded waits
export const WAIT_STEER_GRACE_MS = 5 * 60_000;
export const WAIT_ESCALATION_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const LIVENESS_STALE_MS = 5 * 60_000;
export const MAX_WAIT_STEERS = 2;
export const THREAD_STATUSES: ReadonlySet<string> = new Set(["active", "idle", "error", "starting", "stopping"]);

export const WAIT_ESCALATION_KV_KEY = "wait-validator.escalation";
export const LIVENESS_MARKER_FILENAME = "wait-validator.liveness";
export const LIVENESS_ALERT_FLAG_FILENAME = "wait-validator.alerted";

export function waitValidatorStateDir(): string {
  return process.env.BB_COLLAB_VALIDATOR_STATE_DIR ?? join(homedir(), ".bb", "bb-collab");
}

/** `null` means the source's liveness could not be proven; that is fail-closed. */
export type SourceObservation = { status: string; archived: boolean } | null;

export type RegisterWaitResult =
  | { outcome: "registered"; wait: { waitId: string; waiterThreadId: string; sourceThreadId: string; sourceEvent: "terminal" | "failure"; deadlineAtMs: number }; replay: boolean }
  | { outcome: "refused"; message: string };

export interface BoundedWaitRegistry {
  register(wait: { waitId: string; waiterThreadId: string; sourceThreadId: string; sourceEvent: "terminal" | "failure"; deadlineAtMs: number }): Promise<void>;
  list(): Promise<Array<{ waitId: string; waiterThreadId: string; sourceThreadId: string; sourceEvent: "terminal" | "failure"; deadlineAtMs: number }>>;
  firedWaitIds(): Promise<Array<{ waitId: string; reason: string; waiterThreadId: string }>>;
}

export type WaitFireReason = "source_terminal" | "source_failure" | "deadline_expired";

export interface WaitEscalationRecord {
  waitId: string;
  waiterThreadId: string;
  reason: string;
  firstSeenAtMs: number;
  steers: number;
  failedSteers: number;
  lastSteerAtMs: number | null;
  escalated: boolean;
}

export interface WaitEscalationPersistence {
  read(): Promise<unknown>;
  write(state: Record<string, WaitEscalationRecord>): Promise<void>;
}

export interface WaitCycleSummary {
  outcome: "OK";
  subject: "wait-validator";
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

/**
 * A wait without a deadline is illegal. The deadline is either the type
 * default or an explicit bounded override that must carry a reason; anything
 * else — explicit null, non-integer, in the past, or beyond the horizon — is
 * refused at registration, fail closed.
 */
export function resolveWaitDeadline(input: {
  deadlineAtMs: unknown;
  overrideReason: unknown;
  now: number;
}): { ok: true; deadlineAtMs: number; overrideReason: string | null } | { ok: false; message: string } {
  if (input.deadlineAtMs === undefined) {
    return { ok: true, deadlineAtMs: input.now + DEFAULT_WAIT_DEADLINE_MS, overrideReason: null };
  }
  if (input.deadlineAtMs === null) return { ok: false, message: "wait without a deadline is refused: every wait must be bounded" };
  if (typeof input.deadlineAtMs !== "number" || !Number.isInteger(input.deadlineAtMs)) {
    return { ok: false, message: "wait deadline must be an integer millisecond timestamp" };
  }
  if (input.deadlineAtMs <= input.now) return { ok: false, message: "wait deadline must be in the future" };
  if (input.deadlineAtMs > input.now + MAX_WAIT_DEADLINE_MS) {
    return { ok: false, message: `wait deadline exceeds the ${MAX_WAIT_DEADLINE_MS}ms horizon` };
  }
  if (!nonEmptyString(input.overrideReason, 2048)) {
    return { ok: false, message: "an explicit wait deadline override requires a reason" };
  }
  return { ok: true, deadlineAtMs: input.deadlineAtMs, overrideReason: input.overrideReason };
}

function boundedWaitId(idempotencyKey: string): string {
  // The idempotency key alone determines identity: the same key re-binding a
  // different wait (source, event, or deadline) is a conflict, matching the
  // registry's own "conflicting registered wait" contract.
  return createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 40);
}

/**
 * Sanctioned waiter registration seam: validates the wait against the #93
 * law (waiter binding, source liveness, bounded deadline) and persists it
 * through the one wait registry. The caller's thread is the waiter; a
 * mismatched or absent binding is refused.
 */
export async function registerBoundedWait(options: {
  registry: BoundedWaitRegistry;
  readSource: (threadId: string) => Promise<SourceObservation>;
  input: unknown;
  ctxThreadId?: string;
  now?: () => number;
}): Promise<RegisterWaitResult> {
  const now = options.now ?? Date.now;
  const input = options.input;
  if (!isPlainObject(input)) return { outcome: "refused", message: "wait registration must be a JSON object" };
  let waiterThreadId = nonEmptyString(input.waiterThreadId) ? input.waiterThreadId as string : null;
  if (options.ctxThreadId !== undefined) {
    if (waiterThreadId !== null && waiterThreadId !== options.ctxThreadId) {
      return { outcome: "refused", message: "waiterThreadId does not match the calling thread" };
    }
    waiterThreadId = options.ctxThreadId;
  }
  if (!waiterThreadId) return { outcome: "refused", message: "waiterThreadId is required: register the wait from the waiting thread" };
  const sourceThreadId = nonEmptyString(input.sourceThreadId) ? input.sourceThreadId as string : null;
  if (!sourceThreadId) return { outcome: "refused", message: "sourceThreadId is required: every registered wait names its source" };
  const sourceEvent: "terminal" | "failure" | unknown = input.sourceEvent;
  if (sourceEvent !== "terminal" && sourceEvent !== "failure") {
    return { outcome: "refused", message: 'sourceEvent must be "terminal" or "failure"' };
  }
  if (!nonEmptyString(input.idempotencyKey, 256)) {
    return { outcome: "refused", message: "idempotencyKey is required: every registration names its own key" };
  }

  // Source-liveness validation: a wait on an unknown, archived, or
  // already-errored source is refused — act on its outcome instead.
  let observation: SourceObservation;
  try {
    observation = await options.readSource(sourceThreadId);
  } catch {
    observation = null;
  }
  if (observation === null) {
    return { outcome: "refused", message: `source thread ${sourceThreadId} is unknown: waits on an unverifiable source are refused` };
  }
  if (observation.archived) {
    return { outcome: "refused", message: `source thread ${sourceThreadId} is already archived: act on its outcome instead of waiting` };
  }
  if (!THREAD_STATUSES.has(observation.status)) {
    return { outcome: "refused", message: `source thread ${sourceThreadId} has unknown status ${String(observation.status)}` };
  }
  if (observation.status === "error") {
    return { outcome: "refused", message: `source thread ${sourceThreadId} has already failed: act on its failure instead of waiting` };
  }

  const deadline = resolveWaitDeadline({ deadlineAtMs: input.deadlineAtMs, overrideReason: input.overrideReason, now: now() });
  if (!deadline.ok) return { outcome: "refused", message: deadline.message };

  const wait = {
    waitId: boundedWaitId(nonEmptyString(input.idempotencyKey, 256) ? input.idempotencyKey as string : "default"),
    waiterThreadId,
    sourceThreadId,
    sourceEvent: sourceEvent as "terminal" | "failure",
    deadlineAtMs: deadline.deadlineAtMs,
  };
  // A key whose wait already fired is consumed: replaying it would hand the
  // waiter a dead wait with an expired deadline and no further wake (round-2
  // review finding #1). Check fired state BEFORE the replay branch — a fired
  // wait stays in list() forever, so the later firedAlready guard is dead.
  const firedAlready = (await options.registry.firedWaitIds()).some((fired) => fired.waitId === wait.waitId);
  if (firedAlready) {
    return { outcome: "refused", message: "idempotency key was already consumed by a fired wait: register a new wait with a new key" };
  }
  const existing = (await options.registry.list()).find((candidate) => candidate.waitId === wait.waitId);
  if (existing) {
    // A replay must bind the same wait. An omitted deadline means "the
    // default", whose wall-clock value legitimately differs between calls —
    // so a replay without an explicit deadline matches on the binding, and
    // the ORIGINAL registration's deadline stands.
    const explicitDeadline = input.deadlineAtMs !== undefined;
    const same = existing.waiterThreadId === wait.waiterThreadId &&
      existing.sourceThreadId === wait.sourceThreadId &&
      existing.sourceEvent === wait.sourceEvent &&
      (!explicitDeadline || existing.deadlineAtMs === wait.deadlineAtMs);
    return same
      ? { outcome: "registered", wait: existing, replay: true }
      : { outcome: "refused", message: "idempotency key is already bound to a different wait" };
  }
  await options.registry.register(wait);
  return { outcome: "registered", wait, replay: false };
}

function parseEscalationRecord(value: unknown, maxSteers: number): WaitEscalationRecord {
  if (!isPlainObject(value)) throw new Error("invalid wait escalation state");
  const { waitId, waiterThreadId, reason, firstSeenAtMs, steers, failedSteers, lastSteerAtMs, escalated } = value;
  if (
    !nonEmptyString(waitId, 64) || !nonEmptyString(waiterThreadId) ||
    !(reason === "source_terminal" || reason === "source_failure" || reason === "deadline_expired") ||
    !Number.isInteger(firstSeenAtMs) || (firstSeenAtMs as number) < 0 ||
    !Number.isInteger(steers) || (steers as number) < 0 || (steers as number) > maxSteers ||
    !Number.isInteger(failedSteers) || (failedSteers as number) < 0 || (failedSteers as number) > maxSteers ||
    !(lastSteerAtMs === null || (Number.isInteger(lastSteerAtMs) && (lastSteerAtMs as number) >= 0)) ||
    typeof escalated !== "boolean"
  ) throw new Error("invalid wait escalation state");
  return {
    waitId: waitId as string,
    waiterThreadId: waiterThreadId as string,
    reason: reason as WaitFireReason,
    firstSeenAtMs: firstSeenAtMs as number,
    steers: steers as number,
    failedSteers: failedSteers as number,
    lastSteerAtMs: lastSteerAtMs as number | null,
    escalated: escalated as boolean,
  };
}

export function waitEscalationState(input: unknown, maxSteers: number = MAX_WAIT_STEERS): Record<string, WaitEscalationRecord> {
  if (input === undefined || input === null) return {};
  if (!isPlainObject(input)) throw new Error("invalid wait escalation state");
  const state: Record<string, WaitEscalationRecord> = {};
  for (const [key, value] of Object.entries(input)) state[key] = parseEscalationRecord(value, maxSteers);
  return state;
}

export interface WaitEscalationCycle {
  recover(): Promise<void>;
  cycle(): Promise<WaitCycleSummary>;
}

/**
 * Bounded escalation for fired waits (#93 requirement 6): each fired wait
 * steers its waiter at most twice, grace-spaced, while the waiter is
 * observed idle; an active waiter pauses the ladder (it is alive and the
 * wake reaches it); two ignored or failed steers escalate to exactly ONE
 * operator alert plus a succession trigger, never a steer loop. The ledger
 * lives in the plugin KV seam, so a restart neither re-steers nor forgets.
 */
export function createWaitEscalationCycle(options: {
  registry: BoundedWaitRegistry;
  escalationPersistence?: WaitEscalationPersistence;
  readWaiter: (threadId: string) => Promise<SourceObservation>;
  steerWaiter: (record: { waitId: string; waiterThreadId: string; reason: string }) => Promise<void>;
  onFire?: (record: WaitEscalationRecord) => void;
  onEscalate?: (record: WaitEscalationRecord) => void;
  now?: () => number;
  graceMs?: number;
  maxSteers?: number;
}): WaitEscalationCycle {
  const now = options.now ?? Date.now;
  const graceMs = Number.isInteger(options.graceMs) && (options.graceMs ?? 0) >= 0 ? options.graceMs as number : WAIT_STEER_GRACE_MS;
  const maxSteers = Number.isInteger(options.maxSteers) && (options.maxSteers ?? 0) > 0 ? options.maxSteers as number : MAX_WAIT_STEERS;
  let escalations: Record<string, WaitEscalationRecord> | null = null;
  let queue = Promise.resolve();

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const loaded = async () => {
    if (!escalations) escalations = waitEscalationState(options.escalationPersistence ? await options.escalationPersistence.read() : null, maxSteers);
    return escalations;
  };
  const save = async () => {
    if (options.escalationPersistence && escalations) await options.escalationPersistence.write(structuredClone(escalations));
  };

  return {
    recover: () => enqueue(async () => { await loaded(); }),
    cycle: () => enqueue(async (): Promise<WaitCycleSummary> => {
      const currentNow = now();
      const summary: WaitCycleSummary = { outcome: "OK", subject: "wait-validator", fired: 0, steered: 0, escalated: 0, alerts: 0 };
      const records = await loaded();

      for (const fired of await options.registry.firedWaitIds()) {
        if (records[fired.waitId]) continue; // KV dedupe: a fired wake is steered once ever
        const record: WaitEscalationRecord = {
          waitId: fired.waitId,
          waiterThreadId: fired.waiterThreadId,
          reason: fired.reason,
          firstSeenAtMs: currentNow,
          steers: 0,
          failedSteers: 0,
          lastSteerAtMs: null,
          escalated: false,
        };
        records[record.waitId] = record;
        await save();
        summary.fired += 1;
        summary.alerts += 1;
        options.onFire?.(record);
      }

      const firedIds = new Set((await options.registry.firedWaitIds()).map((fired) => fired.waitId));
      for (const record of Object.values(records)) {
        // Retention prunes only records whose fired wait left the store. A
        // time-based deletion would re-arm the ladder against a wait that is
        // still in firedList(), re-steering and re-alerting forever (round-2
        // review finding #3); the store's own lifetime is the record's.
        if (!firedIds.has(record.waitId) && currentNow - record.firstSeenAtMs > WAIT_ESCALATION_RETENTION_MS) {
          delete records[record.waitId];
          await save();
          continue;
        }
        if (record.escalated) continue;
        let observation: SourceObservation;
        try {
          observation = await options.readWaiter(record.waiterThreadId);
        } catch {
          continue; // unknown waiter state is not evidence to steer or escalate
        }
        if (observation === null) continue;
        // An active waiter is alive: no steer is needed now and escalation is
        // wrong while it demonstrably works. The ladder resumes if it goes
        // idle — activity never marks the wake delivered, because delivery
        // of the wake is proven by acting on it, not by being busy.
        if (observation.status === "active") continue;
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
          await options.steerWaiter(record); // the wake was sent; acting on it is the waiter's move
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
