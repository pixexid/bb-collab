// Acceptance drills for the durable registered-wait validator (#93 / #57
// mechanism 8), from the frozen operator spec at
// docs/issue-93-durable-wait-validator.md. Each drill proves both
// directions: the mechanism acts when it must and refuses/silences when it
// must not. The validator is model-free, read-only on canonical state, and
// fails closed on unknown source/status.
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { readLaneStates } from "../src/awareness.js";
import {
  DEFAULT_WAIT_DEADLINES_MS,
  LIVENESS_STALE_MS,
  MAX_ACTIVE_WAITS,
  WAIT_STEER_GRACE_MS,
  createWaitRegistry,
  createWaitValidator,
  evaluateRegisteredWaits,
  livenessDecision,
  livenessState,
  resolveWaitDeadline,
  type RegisteredWait,
  type SourceObservation,
  type WaitRegistryPersistence,
} from "../src/registered-waits.js";

interface Harness {
  registry: ReturnType<typeof createWaitRegistry>;
  validator: ReturnType<typeof createWaitValidator>;
  sources: Map<string, SourceObservation>;
  waiters: Map<string, SourceObservation>;
  steers: Array<{ waitId: string; reason: string }>;
  alerts: Array<{ kind: string; waitId: string }>;
  escalations: Array<{ waitId: string; escalated: boolean }>;
  kv: Map<string, unknown>;
  laneTerminalThreads: Set<string>;
  now: { value: number };
}

function harness(overrides: { now?: number; graceMs?: number } = {}): Harness {
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
  const registry = createWaitRegistry({
    persistence: persistence("waits"),
    readSource: observe(sources),
    now: () => now.value,
  });
  const validator = createWaitValidator({
    registry,
    escalationPersistence: {
      read: async () => kv.get("escalation"),
      write: async (state) => { kv.set("escalation", structuredClone(state)); },
    },
    readSource: observe(sources),
    readWaiter: observe(waiters),
    readSourceTerminals: () => {
      const terminals = new Map<string, string>();
      for (const threadId of harnessLaneTerminalThreads) terminals.set(threadId, "attempt blocked");
      return terminals;
    },
    steerWaiter: async (target) => { steers.push({ waitId: target.waitId, reason: target.reason }); },
    onFire: (record) => alerts.push({ kind: "fire", waitId: record.waitId }),
    onEscalate: (record) => escalations.push({ waitId: record.waitId, escalated: record.escalated }),
    now: () => now.value,
    graceMs: overrides.graceMs ?? WAIT_STEER_GRACE_MS,
  });
  return { registry, validator, sources, waiters, steers, alerts, escalations, kv, laneTerminalThreads: harnessLaneTerminalThreads, now };
}

const harnessLaneTerminalThreads = new Set<string>();

const waitRequest = (overrides: Record<string, unknown> = {}) => ({
  projectId: "project-1",
  waiterThreadId: "waiter-1",
  eventType: "source_terminal",
  sourceThreadId: "source-1",
  reason: "waiting for the source lane to finish",
  idempotencyKey: "wait-key-1",
  ...overrides,
});

beforeEach(() => {
  harnessLaneTerminalThreads.clear();
});

describe("registered-wait registration (drill: deadline-less wait refused)", () => {
  it("refuses a wait with no deadline: unknown event type has no default", async () => {
    const h = harness();
    const result = await h.registry.register(waitRequest({ eventType: "ci_check" }));
    expect(result).toMatchObject({ outcome: "refused", message: expect.stringContaining("eventType") });
    expect((await h.registry.list()).active).toHaveLength(0);
  });

  it("refuses an explicit null deadline", async () => {
    const h = harness();
    h.sources.set("source-1", { status: "idle", archived: false });
    const result = await h.registry.register(waitRequest({ deadlineMs: null }));
    expect(result).toMatchObject({ outcome: "refused", message: expect.stringContaining("without a deadline") });
  });

  it("refuses past, non-integer, and beyond-horizon deadlines and reasonless overrides", async () => {
    const h = harness();
    h.sources.set("source-1", { status: "idle", archived: false });
    expect(await h.registry.register(waitRequest({ deadlineMs: 999_999, overrideReason: "CI window" }))).toMatchObject({ outcome: "refused" });
    expect(await h.registry.register(waitRequest({ deadlineMs: 1.5, overrideReason: "CI window" }))).toMatchObject({ outcome: "refused" });
    expect(await h.registry.register(waitRequest({ deadlineMs: h.now.value + 8 * 24 * 3600_000, overrideReason: "long" }))).toMatchObject({ outcome: "refused" });
    expect(await h.registry.register(waitRequest({ deadlineMs: h.now.value + 3600_000 }))).toMatchObject({
      outcome: "refused",
      message: expect.stringContaining("override requires a reason"),
    });
  });

  it("applies the per-type default deadline and accepts an explicit override with a reason", async () => {
    const h = harness();
    h.sources.set("source-1", { status: "idle", archived: false });
    const defaulted = await h.registry.register(waitRequest());
    expect(defaulted).toMatchObject({ outcome: "registered", replay: false });
    if (defaulted.outcome !== "registered") throw new Error("unreachable");
    expect(defaulted.wait.deadlineMs).toBe(h.now.value + DEFAULT_WAIT_DEADLINES_MS.source_terminal);

    const overridden = await h.registry.register(waitRequest({
      idempotencyKey: "wait-key-2",
      deadlineMs: h.now.value + 3600_000,
      overrideReason: "CI window is one hour",
    }));
    expect(overridden).toMatchObject({ outcome: "registered" });
    if (overridden.outcome !== "registered") throw new Error("unreachable");
    expect(overridden.wait.overrideReason).toBe("CI window is one hour");
  });

  it("refuses waits on unknown, archived, errored, or unverifiable sources (fail closed)", async () => {
    const h = harness();
    expect(await h.registry.register(waitRequest())).toMatchObject({
      outcome: "refused",
      message: expect.stringContaining("unknown"),
    });
    h.sources.set("source-1", { status: "idle", archived: true });
    expect(await h.registry.register(waitRequest())).toMatchObject({ outcome: "refused", message: expect.stringContaining("archived") });
    h.sources.set("source-1", { status: "error", archived: false });
    expect(await h.registry.register(waitRequest())).toMatchObject({ outcome: "refused", message: expect.stringContaining("failed") });
    h.sources.set("source-1", { status: "weird", archived: false });
    expect(await h.registry.register(waitRequest())).toMatchObject({ outcome: "refused", message: expect.stringContaining("unknown status") });
  });

  it("binds the waiter to the calling thread and refuses a mismatch", async () => {
    const h = harness();
    h.sources.set("source-1", { status: "idle", archived: false });
    expect(await h.registry.register(waitRequest(), "waiter-1")).toMatchObject({ outcome: "registered" });
    expect(await h.registry.register(waitRequest({ idempotencyKey: "wait-key-9" }), "waiter-2")).toMatchObject({
      outcome: "refused",
      message: expect.stringContaining("calling thread"),
    });
  });

  it("replays an identical registration idempotently and refuses conflicting key reuse", async () => {
    const h = harness();
    h.sources.set("source-1", { status: "idle", archived: false });
    const first = await h.registry.register(waitRequest());
    const replay = await h.registry.register(waitRequest());
    expect(replay).toMatchObject({ outcome: "registered", replay: true });
    if (first.outcome !== "registered" || replay.outcome !== "registered") throw new Error("unreachable");
    expect(replay.wait.waitId).toBe(first.wait.waitId);
    expect((await h.registry.list()).active).toHaveLength(1);
    expect(await h.registry.register(waitRequest({ sourceThreadId: "source-2" }))).toMatchObject({
      outcome: "refused",
      message: expect.stringContaining("different wait"),
    });
  });

  it("bounds the registry: at most MAX_ACTIVE_WAITS active waits", async () => {
    const h = harness({ graceMs: 0 });
    h.sources.set("source-1", { status: "idle", archived: false });
    for (let index = 0; index < MAX_ACTIVE_WAITS; index += 1) {
      const result = await h.registry.register(waitRequest({ idempotencyKey: `wait-key-${index}` }));
      expect(result).toMatchObject({ outcome: "registered" });
    }
    expect(await h.registry.register(waitRequest({ idempotencyKey: "overflow" }))).toMatchObject({
      outcome: "refused",
      message: expect.stringContaining("full"),
    });
  });
});

describe("wait evaluation (drill: failure propagates as events, never silence)", () => {
  const wait = (overrides: Partial<RegisteredWait> = {}): RegisteredWait => ({
    waitId: "wait-1",
    projectId: "project-1",
    waiterThreadId: "waiter-1",
    eventType: "source_terminal",
    sourceThreadId: "source-1",
    reason: "waiting",
    overrideReason: null,
    deadlineMs: 1_000_000 + 60_000,
    createdAtMs: 1_000_000,
    idempotencyKey: "wait-key-1",
    ...overrides,
  });

  it("holds while the source is alive and the deadline is in the future", () => {
    const fires = evaluateRegisteredWaits([wait()], new Map([["source-1", { status: "active", archived: false }]]), new Map(), 1_000_030);
    expect(fires).toHaveLength(0);
  });

  it("fires every wait on a source that errors, archives, or reaches a terminal attempt", () => {
    for (const [sources, terminals, detail] of [
      [new Map([["source-1", { status: "error", archived: false }]]), new Map(), "source error"],
      [new Map([["source-1", { status: "idle", archived: true }]]), new Map(), "source archived"],
      [new Map([["source-1", { status: "idle", archived: false }]]), new Map([["source-1", "attempt blocked"]]), "attempt blocked"],
    ] as const) {
      const fires = evaluateRegisteredWaits(
        [wait(), wait({ waitId: "wait-2", waiterThreadId: "waiter-2", idempotencyKey: "wait-key-2" })],
        sources,
        terminals,
        1_000_030,
      );
      expect(fires).toHaveLength(2);
      expect(fires.every((fire) => fire.reason === "source_terminal" && fire.detail === detail)).toBe(true);
    }
  });

  it("holds on unknown source liveness: the deadline stays the only bound", () => {
    const fires = evaluateRegisteredWaits([wait()], new Map([["source-1", null]]), new Map(), 1_000_030);
    expect(fires).toHaveLength(0);
    expect(evaluateRegisteredWaits([wait()], new Map(), new Map(), 1_000_030)).toHaveLength(0);
  });

  it("fires exactly at the deadline with reason deadline_exceeded", () => {
    expect(evaluateRegisteredWaits([wait()], new Map([["source-1", { status: "active", archived: false }]]), new Map(), wait().deadlineMs)).toHaveLength(1);
  });
});

describe("validator cycle (drills: cascade, expiry, dedupe, escalation bounds)", () => {
  it("wakes waiters within one cycle when the source terminalizes, then never re-fires", async () => {
    const h = harness({ graceMs: 10_000 });
    h.sources.set("source-1", { status: "idle", archived: false });
    h.waiters.set("waiter-1", { status: "idle", archived: false });
    const registered = await h.registry.register(waitRequest());
    if (registered.outcome !== "registered") throw new Error("unreachable");

    h.sources.set("source-1", { status: "error", archived: false });
    const summary = await h.validator.cycle();
    expect(summary).toMatchObject({ fired: 1, steered: 1 });
    expect(h.steers).toHaveLength(1);
    expect(h.steers[0]).toMatchObject({ waitId: registered.wait.waitId, reason: "source_terminal" });
    expect(h.alerts).toHaveLength(1);

    const replay = await h.validator.cycle();
    expect(replay).toMatchObject({ fired: 0 });
    expect(h.steers).toHaveLength(1); // dedupe: no second wake
    expect((await h.registry.list()).active).toHaveLength(0);
    expect((await h.registry.list()).terminal[0]).toMatchObject({ outcome: "fired", reason: "source_terminal" });
  });

  it("fires on deadline expiry and only then", async () => {
    const h = harness({ graceMs: 10_000 });
    h.sources.set("source-1", { status: "active", archived: false });
    h.waiters.set("waiter-1", { status: "idle", archived: false });
    await h.registry.register(waitRequest());
    h.sources.delete("source-1"); // unknown liveness must not matter before the deadline
    await h.validator.cycle();
    expect(h.steers).toHaveLength(0);

    h.now.value += DEFAULT_WAIT_DEADLINES_MS.source_terminal + 1;
    const summary = await h.validator.cycle();
    expect(summary).toMatchObject({ fired: 1 });
    expect(h.steers).toHaveLength(1);
    expect(h.steers[0]).toMatchObject({ reason: "deadline_exceeded" });
  });

  it("escalates at most twice, then one operator alert with a succession trigger and never steers again", async () => {
    const h = harness({ graceMs: 10_000 });
    h.sources.set("source-1", { status: "idle", archived: false });
    h.waiters.set("waiter-1", { status: "idle", archived: false });
    await h.registry.register(waitRequest());
    h.sources.set("source-1", { status: "error", archived: false });

    await h.validator.cycle(); // fire + steer 1
    expect(h.steers).toHaveLength(1);
    h.now.value += 20_000;
    await h.validator.cycle(); // steer 2 (ignored)
    expect(h.steers).toHaveLength(2);
    h.now.value += 20_000;
    await h.validator.cycle(); // escalation: one alert, no steer 3
    expect(h.steers).toHaveLength(2);
    expect(h.escalations).toEqual([{ waitId: expect.any(String), escalated: true }]);
    h.now.value += 200_000;
    await h.validator.cycle();
    await h.validator.cycle();
    expect(h.steers).toHaveLength(2); // bounded: never loops steers
    expect(h.escalations).toHaveLength(1); // exactly one operator alert
  });

  it("marks a woken waiter delivered and steers no further", async () => {
    const h = harness({ graceMs: 10_000 });
    h.sources.set("source-1", { status: "idle", archived: false });
    h.waiters.set("waiter-1", { status: "idle", archived: false });
    await h.registry.register(waitRequest());
    h.sources.set("source-1", { status: "error", archived: false });
    await h.validator.cycle();
    h.waiters.set("waiter-1", { status: "active", archived: false });
    h.now.value += 200_000;
    const summary = await h.validator.cycle();
    expect(summary).toMatchObject({ steered: 0, escalated: 0 });
    expect(h.steers).toHaveLength(1);
  });

  it("treats two consecutive failed sends as the escalation condition", async () => {
    const steers: Array<{ waitId: string; reason: string }> = [];
    const sources = new Map<string, SourceObservation>([["source-1", { status: "error", archived: false }]]);
    const kv = new Map<string, unknown>();
    const registry = createWaitRegistry({
      persistence: { read: async () => kv.get("waits"), write: async (state) => { kv.set("waits", structuredClone(state)); } },
      readSource: async () => sources.get("source-1") ?? null,
      now: () => 1_000_000,
    });
    // Register against the pre-error source, then flip it.
    sources.set("source-1", { status: "idle", archived: false });
    await registry.register(waitRequest());
    sources.set("source-1", { status: "error", archived: false });
    const escalations: Array<{ waitId: string; escalated: boolean }> = [];
    const validator = createWaitValidator({
      registry,
      escalationPersistence: { read: async () => kv.get("escalation"), write: async (state) => { kv.set("escalation", structuredClone(state)); } },
      readSource: async () => sources.get("source-1") ?? null,
      readWaiter: async () => ({ status: "idle", archived: false }),
      readSourceTerminals: () => new Map(),
      steerWaiter: async (target) => { steers.push({ waitId: target.waitId, reason: target.reason }); throw new Error("send failed"); },
      onEscalate: (record) => escalations.push({ waitId: record.waitId, escalated: record.escalated }),
      now: () => 1_000_000,
      graceMs: 0,
    });
    await validator.cycle();
    await validator.cycle();
    expect(steers).toHaveLength(2);
    expect(escalations).toHaveLength(1); // two failed steers escalate once
    const summary = await validator.cycle();
    expect(summary).toMatchObject({ steered: 0 });
  });

  it("survives a restart without re-firing or forgetting: a fresh validator replays state from KV", async () => {
    const h = harness({ graceMs: 10_000 });
    h.sources.set("source-1", { status: "idle", archived: false });
    h.waiters.set("waiter-1", { status: "idle", archived: false });
    const registered = await h.registry.register(waitRequest());
    if (registered.outcome !== "registered") throw new Error("unreachable");
    h.sources.set("source-1", { status: "error", archived: false });
    await h.validator.cycle();
    expect(h.steers).toHaveLength(1);

    // Simulate kill -9 + launchd restart: a brand-new registry and validator
    // over the same persisted KV state.
    const kv = h.kv;
    const sources = h.sources;
    const steers: Array<{ waitId: string; reason: string }> = [];
    const registry2 = createWaitRegistry({
      persistence: { read: async () => kv.get("waits"), write: async (state) => { kv.set("waits", structuredClone(state)); } },
      readSource: async (threadId) => sources.get(threadId) ?? null,
      now: () => h.now.value,
    });
    const validator2 = createWaitValidator({
      registry: registry2,
      escalationPersistence: { read: async () => kv.get("escalation"), write: async (state) => { kv.set("escalation", structuredClone(state)); } },
      readSource: async (threadId) => sources.get(threadId) ?? null,
      readWaiter: async (threadId) => h.waiters.get(threadId) ?? null,
      readSourceTerminals: () => new Map(),
      steerWaiter: async (target) => { steers.push({ waitId: target.waitId, reason: target.reason }); },
      now: () => h.now.value,
      graceMs: 10_000,
    });
    await validator2.recover();
    const summary = await validator2.cycle();
    expect(summary).toMatchObject({ fired: 0, evaluated: 0 }); // the wait is terminal: no re-fire
    expect(steers).toHaveLength(0); // no double wake before the grace elapses
    h.now.value += 20_000;
    const next = await validator2.cycle();
    expect(next).toMatchObject({ steered: 1 }); // escalation continues exactly where it left off
  });

  it("never writes a canonical SQLite table: lanes are read-only inputs", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE assignments (project_id TEXT, assignment_id TEXT, lane_id TEXT, assignment_kind TEXT, work_item_id TEXT, created_at_ms INTEGER)");
    db.exec("CREATE TABLE execution_attempts (project_id TEXT, assignment_id TEXT, thread_id TEXT, execution_attempt_id TEXT, origin TEXT, state TEXT, terminal_report_digest TEXT)");
    db.prepare("INSERT INTO assignments VALUES ('project-1','assignment-1','lane-1','write','work-1',1)").run();
    db.prepare("INSERT INTO execution_attempts VALUES ('project-1','assignment-1','source-1','attempt-1','assignment','running',NULL)").run();
    const dump = () => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
      return JSON.stringify(tables.map((table) => [table.name, db.prepare(`SELECT * FROM ${table.name}`).all()]));
    };
    const before = dump();

    const terminals = new Map<string, string>();
    for (const lane of readLaneStates(db)) {
      if (lane.thread_id && lane.terminal_report_digest !== null) terminals.set(lane.thread_id, "terminal receipt");
    }
    expect(terminals).toHaveLength(0); // running attempt without receipt: not terminal

    const kv = new Map<string, unknown>();
    const registry = createWaitRegistry({
      persistence: { read: async () => kv.get("waits"), write: async (state) => { kv.set("waits", structuredClone(state)); } },
      readSource: async () => ({ status: "idle", archived: false }),
      now: () => 1_000_000,
    });
    await registry.register(waitRequest());
    const validator = createWaitValidator({
      registry,
      escalationPersistence: { read: async () => kv.get("escalation"), write: async (state) => { kv.set("escalation", structuredClone(state)); } },
      readSource: async () => ({ status: "idle", archived: false }),
      readWaiter: async () => ({ status: "idle", archived: false }),
      readSourceTerminals: () => {
        const map = new Map<string, string>();
        for (const lane of readLaneStates(db)) {
          if (lane.thread_id && lane.terminal_report_digest !== null) map.set(lane.thread_id, "terminal receipt");
        }
        return map;
      },
      steerWaiter: async () => {},
      now: () => 1_000_000,
      graceMs: 0,
    });
    await validator.cycle();
    expect(dump()).toBe(before); // zero canonical writes
    db.close();
  });
});

describe("self-watch, once (drill: stale marker alerts exactly once)", () => {
  it("decides fresh, stale, and missing markers fail closed", () => {
    const now = 10_000_000;
    expect(livenessState(now - 1_000, now)).toBe("fresh");
    expect(livenessState(now - LIVENESS_STALE_MS, now)).toBe("stale");
    expect(livenessState(null, now)).toBe("missing");
    expect(livenessState(Number.NaN, now)).toBe("missing");
  });

  it("alerts exactly once per staleness episode and re-arms after recovery", () => {
    expect(livenessDecision("stale", false)).toBe("alert-once");
    expect(livenessDecision("stale", true)).toBe("silent"); // no repeat
    expect(livenessDecision("missing", false)).toBe("silent"); // not launchd-failure evidence
    expect(livenessDecision("fresh", true)).toBe("clear-alert-flag"); // episode closes
    expect(livenessDecision("fresh", false)).toBe("silent");
    expect(livenessDecision("missing", true)).toBe("silent"); // flag kept until a fresh marker proves recovery
  });
});

describe("deadline resolution unit contract", () => {
  it("is total over the event types and refuses everything else", () => {
    const now = 1_000;
    for (const [eventType, deadline] of Object.entries(DEFAULT_WAIT_DEADLINES_MS)) {
      expect(resolveWaitDeadline({ eventType, deadlineMs: undefined, overrideReason: undefined, now })).toEqual({
        ok: true,
        deadlineMs: now + deadline,
        overrideReason: null,
      });
    }
    expect(resolveWaitDeadline({ eventType: "mystery", deadlineMs: undefined, overrideReason: undefined, now }).ok).toBe(false);
  });
});
