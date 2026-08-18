// Acceptance drills for the durable wait-validator layer (#93 / #57
// mechanism 8), built on the merged registered-wait substrate from
// src/awareness.ts (PR #95). The wait store is exactly one registry; this
// layer adds the deadline law, fail-closed source-liveness validation, and
// the bounded escalation ladder. Each drill proves both directions.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  createWaitRegistry,
  type WaitRegistryPersistence,
} from "../src/awareness.js";
import {
  DEFAULT_WAIT_DEADLINE_MS,
  LIVENESS_STALE_MS,
  MAX_WAIT_DEADLINE_MS,
  WAIT_STEER_GRACE_MS,
  createWaitEscalationCycle,
  livenessDecision,
  livenessState,
  registerBoundedWait,
  resolveWaitDeadline,
  type SourceObservation,
} from "../src/registered-waits.js";

interface Harness {
  registry: ReturnType<typeof createWaitRegistry>;
  escalation: ReturnType<typeof createWaitEscalationCycle>;
  sources: Map<string, SourceObservation>;
  waiters: Map<string, SourceObservation>;
  steers: Array<{ waitId: string; reason: string }>;
  alerts: Array<{ kind: string; waitId: string }>;
  escalations: Array<{ waitId: string; escalated: boolean }>;
  kv: Map<string, unknown>;
  now: { value: number };
}

function harness(overrides: { now?: number; graceMs?: number; terminalReceipt?: boolean } = {}): Harness {
  const sources = new Map<string, SourceObservation>();
  const waiters = new Map<string, SourceObservation>();
  const steers: Array<{ waitId: string; reason: string }> = [];
  const alerts: Array<{ kind: string; waitId: string }> = [];
  const escalations: Array<{ waitId: string; escalated: boolean }> = [];
  const kv = new Map<string, unknown>();
  const now = { value: overrides.now ?? 1_000_000 };
  const persistence = (key: string): WaitRegistryPersistence => ({
    read: async () => kv.get(key),
    write: async (state) => { kv.set(key, structuredClone(state)); },
  });
  const observe = (map: Map<string, SourceObservation>) => async (threadId: string): Promise<SourceObservation> => {
    const observation = map.get(threadId);
    return observation === undefined || observation === null ? null : { ...observation };
  };
  const registry = createWaitRegistry(persistence("waits"));
  const escalation = createWaitEscalationCycle({
    registry: bounded(registry),
    escalationPersistence: {
      read: async () => kv.get("escalation"),
      write: async (state) => { kv.set("escalation", structuredClone(state)); },
    },
    readWaiter: observe(waiters),
    steerWaiter: async (target) => { steers.push({ waitId: target.waitId, reason: target.reason }); },
    onFire: (record) => alerts.push({ kind: "fire", waitId: record.waitId }),
    onEscalate: (record) => escalations.push({ waitId: record.waitId, escalated: record.escalated }),
    now: () => now.value,
    graceMs: overrides.graceMs ?? WAIT_STEER_GRACE_MS,
  });
  return { registry, escalation, sources, waiters, steers, alerts, escalations, kv, now };
}

/** Register through the harness clock. */
async function boundedRegister(h: Harness, input: unknown, ctxThreadId?: string) {
  return registerBoundedWait({
    registry: bounded(h.registry),
    readSource: async (threadId: string) => h.sources.get(threadId) ?? null,
    readWaker: async (schedule: string) => schedule === "wait-validator-liveness",
    input,
    ctxThreadId,
    now: () => h.now.value,
  });
}

/** Adapter from the one wait registry to the bounded validator seam. */
const bounded = (r: ReturnType<typeof createWaitRegistry>) => ({
  register: (wait: Parameters<typeof r.register>[0]) => r.register(wait),
  list: async () => { await r.recover(); return r.list(); },
  firedWaitIds: async () => { await r.recover(); return r.firedList() as Array<{ waitId: string; reason: string; waiterThreadId: string }>; },
});

const waitRequest = (overrides: Record<string, unknown> = {}) => ({
  waiterThreadId: "waiter-1",
  sourceThreadId: "source-1",
  sourceEvent: "terminal",
  reason: "waiting for the source lane to finish",
  idempotencyKey: "wait-key-1",
  wakerSchedule: "wait-validator-liveness",
  ...overrides,
});

describe("registered-wait registration (drill: deadline-less wait refused)", () => {
  it("refuses a wait with an explicit null or invalid deadline, fail closed", async () => {
    const h = harness();
    h.sources.set("source-1", { status: "idle", archived: false });
    expect(await boundedRegister(h, waitRequest({ deadlineAtMs: null }))).toMatchObject({
      outcome: "refused",
      message: expect.stringContaining("without a deadline"),
    });
    expect(await boundedRegister(h, waitRequest({ deadlineAtMs: 1.5 }))).toMatchObject({ outcome: "refused" });
    expect(await boundedRegister(h, waitRequest({ deadlineAtMs: 999_999, overrideReason: "x" }))).toMatchObject({ outcome: "refused" });
    expect(h.registry.list()).toHaveLength(0);
  });

  it("applies the default deadline and accepts an explicit override with a reason", async () => {
    const h = harness();
    h.sources.set("source-1", { status: "idle", archived: false });
    const defaulted = await boundedRegister(h, waitRequest());
    expect(defaulted).toMatchObject({ outcome: "registered", replay: false });
    if (defaulted.outcome !== "registered") throw new Error("unreachable");
    expect(defaulted.wait.deadlineAtMs).toBe(h.now.value + DEFAULT_WAIT_DEADLINE_MS);

    const override = await boundedRegister(h, waitRequest({
      idempotencyKey: "wait-key-2",
      deadlineAtMs: h.now.value + 3600_000,
      overrideReason: "CI window is one hour",
    }));
    expect(override).toMatchObject({ outcome: "registered" });
  });

  it("refuses a reasonless override, a beyond-horizon deadline, and an unknown event kind", async () => {
    const h = harness();
    h.sources.set("source-1", { status: "idle", archived: false });
    expect(await boundedRegister(h, waitRequest({ deadlineAtMs: h.now.value + 3600_000 }))).toMatchObject({
      outcome: "refused",
      message: expect.stringContaining("override requires a reason"),
    });
    expect(await boundedRegister(h, waitRequest({ deadlineAtMs: h.now.value + MAX_WAIT_DEADLINE_MS + 1, overrideReason: "too long" }))).toMatchObject({
      outcome: "refused",
      message: expect.stringContaining("horizon"),
    });
    expect(await boundedRegister(h, waitRequest({ sourceEvent: "ci_check" }))).toMatchObject({
      outcome: "refused",
      message: expect.stringContaining("sourceEvent"),
    });
  });

  it("refuses waits on unknown, archived, errored, or unknown-status sources (fail closed)", async () => {
    const h = harness();
    expect(await boundedRegister(h, waitRequest())).toMatchObject({
      outcome: "refused",
      message: expect.stringContaining("unknown"),
    });
    h.sources.set("source-1", { status: "idle", archived: true });
    expect(await boundedRegister(h, waitRequest())).toMatchObject({ outcome: "refused", message: expect.stringContaining("archived") });
    h.sources.set("source-1", { status: "error", archived: false });
    expect(await boundedRegister(h, waitRequest())).toMatchObject({ outcome: "refused", message: expect.stringContaining("failed") });
    h.sources.set("source-1", { status: "weird", archived: false });
    expect(await boundedRegister(h, waitRequest())).toMatchObject({ outcome: "refused", message: expect.stringContaining("unknown status") });
  });

  it("refuses a keyless registration: no shared default waitId", async () => {
    const h = harness();
    h.sources.set("source-1", { status: "idle", archived: false });
    const keyless = { ...waitRequest() } as Record<string, unknown>;
    delete keyless.idempotencyKey;
    expect(await boundedRegister(h, keyless)).toMatchObject({
      outcome: "refused",
      message: expect.stringContaining("idempotencyKey is required"),
    });
    expect(h.registry.list()).toHaveLength(0);
  });

  it("refuses an explicit-deadline replay with a different explicit deadline", async () => {
    const h = harness();
    h.sources.set("source-1", { status: "idle", archived: false });
    expect(await boundedRegister(h, waitRequest({ deadlineAtMs: h.now.value + 3600_000, overrideReason: "first window" }))).toMatchObject({ outcome: "registered" });
    expect(await boundedRegister(h, waitRequest({ deadlineAtMs: h.now.value + 7200_000, overrideReason: "second window" }))).toMatchObject({
      outcome: "refused",
      message: expect.stringContaining("different wait"),
    });
  });

  it("binds the waiter to the calling thread and replays idempotently", async () => {
    const h = harness();
    h.sources.set("source-1", { status: "idle", archived: false });
    expect(await boundedRegister(h, waitRequest(), "waiter-1")).toMatchObject({ outcome: "registered" });
    expect(await boundedRegister(h, waitRequest({ idempotencyKey: "wait-key-9" }), "waiter-2")).toMatchObject({
      outcome: "refused",
      message: expect.stringContaining("calling thread"),
    });
    expect(await boundedRegister(h, waitRequest(), "waiter-1")).toMatchObject({
      outcome: "registered",
      replay: true,
    });
    expect(h.registry.list()).toHaveLength(1);
    expect(await boundedRegister(h, waitRequest({ sourceEvent: "failure" }), "waiter-1")).toMatchObject({
      outcome: "refused",
      message: expect.stringContaining("different wait"),
    });
  });
});

describe("self-watch, once (drill: stale marker alerts exactly once)", () => {
  it("classifies fresh, stale, and missing markers fail closed", () => {
    const now = 10_000_000;
    expect(livenessState(now - 1_000, now)).toBe("fresh");
    expect(livenessState(now - LIVENESS_STALE_MS, now)).toBe("stale");
    expect(livenessState(null, now)).toBe("missing");
    expect(livenessState(Number.NaN, now)).toBe("missing");
  });

  it("alerts exactly once per staleness episode and re-arms after recovery", () => {
    expect(livenessDecision("stale", false)).toBe("alert-once");
    expect(livenessDecision("stale", true)).toBe("silent");
    expect(livenessDecision("missing", false)).toBe("silent");
    expect(livenessDecision("missing", true)).toBe("silent");
    expect(livenessDecision("fresh", true)).toBe("clear-alert-flag");
    expect(livenessDecision("fresh", false)).toBe("silent");
  });
});

describe("deadline resolution unit contract", () => {
  it("is total over the input space and refuses everything illegal", () => {
    const now = 1_000;
    expect(resolveWaitDeadline({ deadlineAtMs: undefined, overrideReason: undefined, now })).toEqual({
      ok: true,
      deadlineAtMs: now + DEFAULT_WAIT_DEADLINE_MS,
      overrideReason: null,
    });
    expect(resolveWaitDeadline({ deadlineAtMs: null, overrideReason: "why", now }).ok).toBe(false);
    expect(resolveWaitDeadline({ deadlineAtMs: now, overrideReason: "why", now }).ok).toBe(false);
    expect(resolveWaitDeadline({ deadlineAtMs: now + MAX_WAIT_DEADLINE_MS + 1, overrideReason: "why", now }).ok).toBe(false);
    expect(resolveWaitDeadline({ deadlineAtMs: now + 5_000, overrideReason: "", now }).ok).toBe(false);
    expect(resolveWaitDeadline({ deadlineAtMs: now + 5_000, overrideReason: "short window", now })).toEqual({
      ok: true,
      deadlineAtMs: now + 5_000,
      overrideReason: "short window",
    });
  });
});
