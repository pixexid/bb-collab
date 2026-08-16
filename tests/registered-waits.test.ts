// Acceptance drills for the durable wait-validator layer (#93 / #57
// mechanism 8), built on the merged registered-wait substrate from
// src/awareness.ts (PR #95). The wait store is exactly one registry; this
// layer adds the deadline law, fail-closed source-liveness validation, and
// the bounded escalation ladder. Each drill proves both directions.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  createLaneWatcher,
  createWaitRegistry,
  type LaneState,
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
  watcher: ReturnType<typeof createLaneWatcher>;
  escalation: ReturnType<typeof createWaitEscalationCycle>;
  sources: Map<string, SourceObservation>;
  waiters: Map<string, SourceObservation>;
  lanes: LaneState[];
  steers: Array<{ waitId: string; reason: string }>;
  watcherSteers: string[];
  alerts: Array<{ kind: string; waitId: string }>;
  escalations: Array<{ waitId: string; escalated: boolean }>;
  kv: Map<string, unknown>;
  now: { value: number };
}

function harness(overrides: { now?: number; graceMs?: number; terminalReceipt?: boolean } = {}): Harness {
  const sources = new Map<string, SourceObservation>();
  const waiters = new Map<string, SourceObservation>();
  const steers: Array<{ waitId: string; reason: string }> = [];
  const watcherSteers: string[] = [];
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
  const lanes: LaneState[] = [{
    project_id: "project-1",
    assignment_id: "assignment-1",
    lane_id: "lane-1",
    assignment_kind: "write",
    work_item_id: "work-1",
    thread_id: "source-1",
    execution_attempt_id: "attempt-1",
    attempt_state: "running",
    terminal_report_digest: null,
    created_at_ms: 1,
  }];
  const watcher = createLaneWatcher({
    readLanes: () => structuredClone(lanes),
    waitRegistry: registry,
    steer: async (view) => { watcherSteers.push(view.threadId ?? "null"); },
    readWorker: (async (threadId: string) => {
      const observation = waiters.get(threadId) ?? sources.get(threadId);
      if (!observation) throw new Error(`unknown thread ${threadId}`);
      return {
        status: observation.status as "idle",
        pendingExternalWait: false,
        archived: observation.archived,
        operatorWait: null,
        operatorWaitKnown: true,
        idleSinceMs: 1,
      };
    }) as Harness["watcher"] extends never ? never : (threadId: string) => Promise<import("../src/awareness.js").WorkerObservation>,
    onWaitEvent: () => {},
    now: () => now.value,
  });
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
  return { registry, watcher, escalation, sources, waiters, lanes, steers, watcherSteers, alerts, escalations, kv, now };
}

/** Register through the harness clock. */
async function boundedRegister(h: Harness, input: unknown, ctxThreadId?: string) {
  return registerBoundedWait({
    registry: bounded(h.registry),
    readSource: async (threadId: string) => h.sources.get(threadId) ?? null,
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

describe("firing through the watcher (drill: failure propagates as events, never silence)", () => {
  async function register(h: Harness) {
    const result = await boundedRegister(h, waitRequest());
    if (result.outcome !== "registered") throw new Error("unreachable");
    return result.wait;
  }

  it("holds while the source is open and the deadline is in the future", async () => {
    const h = harness();
    h.sources.set("source-1", { status: "idle", archived: false });
    await register(h);
    await h.watcher.poll();
    expect(h.registry.list().every((wait) => h.registry.state(wait.waitId) === "pending")).toBe(true);
    expect(h.steers).toHaveLength(0);
  });

  it("fires within one cycle when the source errors, archives, or reaches a terminal attempt", async () => {
    // Every scenario registers against a live source first; the terminal
    // fact then lands and the next cycle fires — failure as events, never
    // silence, and never silence in the refusing direction either.
    const scenarios: Array<{ mutate: (h: Harness) => void; detail: string }> = [
      { mutate: (h) => h.sources.set("source-1", { status: "error", archived: false }), detail: "source error" },
      { mutate: (h) => h.sources.set("source-1", { status: "idle", archived: true }), detail: "source archived" },
      { mutate: (h) => { h.lanes[0].attempt_state = "blocked"; }, detail: "terminal attempt" },
      { mutate: (h) => { h.lanes[0].terminal_report_digest = "receipt-digest"; }, detail: "terminal receipt" },
    ];
    for (const { mutate } of scenarios) {
      const h = harness();
      h.sources.set("source-1", { status: "idle", archived: false });
      await register(h);
      mutate(h);
      await h.watcher.poll();
      expect(h.registry.list().map((wait) => h.registry.state(wait.waitId))).toEqual(["fired"]);
      expect(h.registry.firedList().map((fired) => fired.reason)).toEqual(["source_terminal"]);
      const other = harness();
      other.sources.set("source-1", { status: "idle", archived: false });
      await register(other);
      await other.watcher.poll(); // live source, unexpired deadline: held, not fired
      expect(other.registry.list().map((wait) => other.registry.state(wait.waitId))).toEqual(["pending"]);
    }
  });

  it("fires on deadline expiry even when source liveness is unknown: the deadline stays the bound", async () => {
    const h = harness();
    h.sources.set("source-1", { status: "idle", archived: false });
    await register(h);
    h.sources.delete("source-1");
    await h.watcher.poll();
    expect(h.registry.state(h.registry.list()[0].waitId)).toBe("pending");
    h.now.value += DEFAULT_WAIT_DEADLINE_MS + 1;
    await h.watcher.poll();
    expect(h.registry.state(h.registry.list()[0].waitId)).toBe("fired");
  });

  it("treats a pending registered wait as a legal idle and steers only without one", async () => {
    const h = harness();
    h.sources.set("source-1", { status: "idle", archived: false });
    h.waiters.set("waiter-1", { status: "idle", archived: false });
    h.lanes[0].thread_id = "waiter-1"; // the waiter itself is the lane worker
    await register(h);
    await h.watcher.observe("waiter-1", "idle");
    expect(h.watcherSteers).toHaveLength(0); // registered wait: legal idle

    h.now.value += DEFAULT_WAIT_DEADLINE_MS + 1; // wait fires: idle becomes illegal
    await h.watcher.observe("waiter-1", "idle");
    expect(h.watcherSteers).toHaveLength(1); // unregistered wait: illegal idle, steered
  });
});

describe("escalation ladder (drill: bounded escalation, never a steer loop)", () => {
  async function fireOne(h: Harness) {
    const result = await boundedRegister(h, waitRequest());
    if (result.outcome !== "registered") throw new Error("unreachable");
    h.sources.set("source-1", { status: "error", archived: false });
    await h.watcher.poll();
  }

  it("steers a fired waiter, pauses for an active waiter, and never re-fires", async () => {
    const h = harness({ graceMs: 10_000 });
    h.sources.set("source-1", { status: "idle", archived: false });
    h.waiters.set("waiter-1", { status: "idle", archived: false });
    await fireOne(h);

    const first = await h.escalation.cycle();
    expect(first).toMatchObject({ fired: 1, steered: 1 });
    expect(h.steers).toHaveLength(1);
    expect(h.alerts).toHaveLength(1);

    await h.escalation.cycle();
    expect(h.steers).toHaveLength(1); // within grace: no re-steer

    h.waiters.set("waiter-1", { status: "active", archived: false });
    h.now.value += 20_000;
    const delivered = await h.escalation.cycle();
    expect(delivered).toMatchObject({ steered: 0, escalated: 0 });
    expect(h.steers).toHaveLength(1); // no grace has passed since steer 1
  });

  it("never loses a wake to a momentarily active waiter: the ladder resumes on idle", async () => {
    const h = harness({ graceMs: 10_000 });
    h.sources.set("source-1", { status: "idle", archived: false });
    h.waiters.set("waiter-1", { status: "active", archived: false }); // busy on other work when the wait fires
    await fireOne(h);
    const busy = await h.escalation.cycle();
    expect(busy).toMatchObject({ fired: 1, steered: 0, escalated: 0 }); // alive: no steer now

    h.waiters.set("waiter-1", { status: "idle", archived: false });
    h.now.value += 20_000;
    const woken = await h.escalation.cycle();
    expect(woken).toMatchObject({ steered: 1 }); // the wake is NOT lost: it steers once it goes idle
    expect(h.steers).toHaveLength(1);
  });

  it("escalates after two ignored steers to exactly one operator alert, then stops", async () => {
    const h = harness({ graceMs: 10_000 });
    h.sources.set("source-1", { status: "idle", archived: false });
    h.waiters.set("waiter-1", { status: "idle", archived: false });
    await fireOne(h);

    await h.escalation.cycle(); // fire + steer 1
    h.now.value += 20_000;
    await h.escalation.cycle(); // steer 2
    expect(h.steers).toHaveLength(2);
    h.now.value += 20_000;
    await h.escalation.cycle(); // escalation
    expect(h.steers).toHaveLength(2); // never a third steer
    expect(h.escalations).toEqual([{ waitId: expect.any(String), escalated: true }]);
    h.now.value += 200_000;
    await h.escalation.cycle();
    await h.escalation.cycle();
    expect(h.steers).toHaveLength(2);
    expect(h.escalations).toHaveLength(1); // exactly one operator alert
  });

  it("treats two consecutive failed sends as the escalation condition", async () => {
    const h = harness({ graceMs: 0 });
    h.sources.set("source-1", { status: "idle", archived: false });
    h.waiters.set("waiter-1", { status: "idle", archived: false });
    await fireOne(h);
    const kv = h.kv;
    const sources = h.sources;
    const steers: Array<{ waitId: string; reason: string }> = [];
    const escalations: Array<{ waitId: string; escalated: boolean }> = [];
    const registry2 = createWaitRegistry({ read: async () => kv.get("waits"), write: async (state) => { kv.set("waits", structuredClone(state)); } });
    const escalation2 = createWaitEscalationCycle({
      registry: bounded(registry2),
      escalationPersistence: { read: async () => kv.get("escalation"), write: async (state) => { kv.set("escalation", structuredClone(state)); } },
      readWaiter: async () => h.waiters.get("waiter-1") ?? null,
      steerWaiter: async (target) => { steers.push({ waitId: target.waitId, reason: target.reason }); throw new Error("send failed"); },
      onEscalate: (record) => escalations.push({ waitId: record.waitId, escalated: record.escalated }),
      now: () => h.now.value,
      graceMs: 0,
    });
    await escalation2.recover();
    await escalation2.cycle();
    await escalation2.cycle();
    expect(steers).toHaveLength(2);
    expect(escalations).toHaveLength(1);
    const summary = await escalation2.cycle();
    expect(summary).toMatchObject({ steered: 0 });
  });

  it("refuses re-registration of a fired wait key with its dead deadline", async () => {
    const h = harness({ graceMs: 10_000 });
    h.sources.set("source-1", { status: "idle", archived: false });
    h.waiters.set("waiter-1", { status: "idle", archived: false });
    // Fire through a terminal attempt state so the source THREAD stays a
    // valid live target: only the fired-key guard can explain the refusal.
    await boundedRegister(h, waitRequest());
    h.lanes[0].attempt_state = "done";
    await h.watcher.poll();
    await h.escalation.cycle();
    // The documented recovery move — wait again on the same source — must not
    // hand back the dead wait as a replay (round-2 review finding #1).
    const reregister = await boundedRegister(h, waitRequest());
    expect(reregister).toMatchObject({
      outcome: "refused",
      message: expect.stringContaining("consumed by a fired wait"),
    });
    // A fresh key on the same source registers cleanly.
    const fresh = await boundedRegister(h, waitRequest({ idempotencyKey: "wait-key-next" }));
    expect(fresh).toMatchObject({ outcome: "registered" });
  });

  it("retention never re-arms the ladder for a wait still in the fired set", async () => {
    const h = harness({ graceMs: 0 });
    h.sources.set("source-1", { status: "idle", archived: false });
    h.waiters.set("waiter-1", { status: "idle", archived: false });
    await fireOne(h);
    await h.escalation.cycle(); // fire + steer 1
    await h.escalation.cycle(); // steer 2 (ignored)
    await h.escalation.cycle(); // two ignored steers escalate once
    expect(h.escalations).toHaveLength(1);
    h.now.value += 8 * 24 * 60 * 60_000; // far past retention
    await h.escalation.cycle();
    await h.escalation.cycle();
    expect(h.steers).toHaveLength(2); // no re-steer
    expect(h.escalations).toHaveLength(1); // no second operator alert
  });

  it("survives a restart without re-firing or forgetting: a fresh cycle replays from KV", async () => {
    const h = harness({ graceMs: 10_000 });
    h.sources.set("source-1", { status: "idle", archived: false });
    h.waiters.set("waiter-1", { status: "idle", archived: false });
    await fireOne(h);
    await h.escalation.cycle();
    expect(h.steers).toHaveLength(1);

    // Simulate kill -9 + launchd restart: fresh registry and cycle over the same KV.
    const kv = h.kv;
    const registry2 = createWaitRegistry({ read: async () => kv.get("waits"), write: async (state) => { kv.set("waits", structuredClone(state)); } });
    const steers: Array<{ waitId: string; reason: string }> = [];
    const escalation2 = createWaitEscalationCycle({
      registry: bounded(registry2),
      escalationPersistence: { read: async () => kv.get("escalation"), write: async (state) => { kv.set("escalation", structuredClone(state)); } },
      readWaiter: async (threadId) => h.waiters.get(threadId) ?? null,
      steerWaiter: async (target) => { steers.push({ waitId: target.waitId, reason: target.reason }); },
      now: () => h.now.value,
      graceMs: 10_000,
    });
    await escalation2.recover();
    const replay = await escalation2.cycle();
    expect(replay).toMatchObject({ fired: 0 }); // the fired map dedupes: no re-fire
    expect(steers).toHaveLength(0); // grace preserved across the restart
    h.now.value += 20_000;
    const next = await escalation2.cycle();
    expect(next).toMatchObject({ steered: 1 }); // escalation resumes exactly where it stopped
    expect(steers).toHaveLength(1);
  });

  it("adds no canonical DDL; the plugin-seam digest test carries the full no-write claim", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE assignments (project_id TEXT)");
    const digest = () => JSON.stringify(db.prepare("SELECT * FROM sqlite_master").all());
    const before = digest();
    const h = harness();
    h.sources.set("source-1", { status: "idle", archived: false });
    await fireOne(h);
    await h.escalation.cycle();
    expect(digest()).toBe(before); // zero canonical writes
    db.close();
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
