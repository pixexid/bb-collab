import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { environmentDependentFromEvents, readExecutedProfiles } from "../scripts/read-executed-profile.mjs";

const completion = (providerThreadId, checkpointId) => ({
  id: `event-${checkpointId}`,
  seq: 10,
  type: "turn/completed",
  data: { status: "completed", providerThreadId, providerCheckpointId: checkpointId },
});

const interrupted = (providerThreadId, scopeTurnId, status = "interrupted") => ({
  id: "event-interrupted",
  seq: 20,
  scope: { kind: "turn", turnId: scopeTurnId },
  type: "turn/completed",
  data: { status, providerThreadId, providerCheckpointId: null },
});

function activeEvents(providerThreadId, nativeTurnId = "active-turn") {
  const scope = { kind: "turn", turnId: `bta2647fb7-1-${nativeTurnId}` };
  return [
    { id: "event-requested", seq: 10, type: "client/turn/requested", data: { requestId: "request-active" }, createdAt: Date.parse("2026-08-20T00:00:10.000Z") },
    { id: "event-active", seq: 11, type: "turn/started", data: { providerThreadId }, scope, createdAt: Date.parse("2026-08-20T00:00:11.000Z") },
    { id: "event-accepted", seq: 12, type: "turn/input/accepted", data: { providerThreadId, clientRequestId: "request-active" }, scope, createdAt: Date.parse("2026-08-20T00:00:11.000Z") },
  ];
}

function continuationEvents(providerThreadId, nativeTurnId = "continuation-turn") {
  const firstScope = { kind: "turn", turnId: `bta2647fb7-1-first-turn` };
  const currentScope = { kind: "turn", turnId: `bta2647fb7-1-${nativeTurnId}` };
  return [
    { id: "event-requested", seq: 10, type: "client/turn/requested", data: { requestId: "request-initial" }, createdAt: Date.parse("2026-08-20T00:00:10.000Z") },
    { id: "event-first-started", seq: 11, type: "turn/started", data: { providerThreadId }, scope: firstScope, createdAt: Date.parse("2026-08-20T00:00:11.000Z") },
    { id: "event-first-accepted", seq: 12, type: "turn/input/accepted", data: { providerThreadId, clientRequestId: "request-initial" }, scope: firstScope, createdAt: Date.parse("2026-08-20T00:00:11.000Z") },
    { id: "event-first-completed", seq: 13, type: "turn/completed", data: { status: "completed", providerThreadId, providerCheckpointId: "first-turn" }, scope: firstScope, createdAt: Date.parse("2026-08-20T00:00:13.000Z") },
    { id: "event-continuation-started", seq: 14, type: "turn/started", data: { providerThreadId }, scope: currentScope, createdAt: Date.parse("2026-08-20T00:00:14.000Z") },
  ];
}

function stoppedEvents(providerThreadId, nativeTurnId, status = "interrupted", prefix = "bta2647fb7") {
  const scopeTurnId = prefix === "bta2647fb7" ? `${prefix}-1-${nativeTurnId}` : `${prefix}-${nativeTurnId}`;
  return [
    { id: "event-started", seq: 10, type: "turn/started", data: { providerThreadId }, scope: { kind: "turn", turnId: scopeTurnId } },
    interrupted(providerThreadId, scopeTurnId, status),
  ];
}

function jsonl(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

const piBridgeLog = (home, providerThreadId, directory = join(home, ".bb", "pi-bridge-sessions")) =>
  join(directory, `${providerThreadId.replace(/[^A-Za-z0-9._-]/gu, "_")}.jsonl`);

const zcodeAttestation = {
  schema: "zcode-acp.attestation/v1",
  providerId: "builtin:zai-coding-plan",
  modelId: "GLM-5.3",
  variant: "max",
  requestId: "request-zcode",
  turnId: "turn-zcode",
  resultType: "success",
  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, cacheReadTokens: 0 },
  durationMs: 4,
  toolCallCount: 0,
};

function zcodeEvents(providerThreadId, scopeTurnId, result = JSON.stringify(zcodeAttestation)) {
  const item = { type: "toolCall", id: `zcode-attest-${scopeTurnId}`, result };
  const scope = { kind: "turn", turnId: scopeTurnId };
  return [
    { id: "zcode-item-started", seq: 10, scope, type: "item/started", data: { providerThreadId, item: { type: "toolCall", id: item.id } } },
    { id: "zcode-item-completed", seq: 11, scope, type: "item/completed", data: { providerThreadId, item } },
    { id: "zcode-turn-completed", seq: 12, scope, type: "turn/completed", data: { status: "completed", providerThreadId, providerCheckpointId: "zcode-checkpoint" } },
  ];
}

describe("executed profile read-back", () => {
  it("DISCRIMINATOR: reads the executed acp-zcode attestation, not requested settings", async () => {
    const scopeTurnId = "bta2647fb7-1-zcode-turn";
    const result = await readExecutedProfiles({
      thread: { providerId: "acp-zcode", status: "idle", model: "REQUESTED_MODEL_DO_NOT_EMIT", reasoningLevel: "REQUESTED_VARIANT_DO_NOT_EMIT" },
      environment: { path: "/test/project" },
      events: zcodeEvents("zcode-session", scopeTurnId),
      expectedTurnId: scopeTurnId,
    });
    expect(result).toMatchObject({
      outcome: "known",
      coverage: { completedTurns: 1, knownTurns: 1, unknownTurns: 0, noExecutionTurns: 0 },
      turns: [{ status: "known", executedProfile: { providerId: "builtin:zai-coding-plan", model: "GLM-5.3", reasoningLevel: "max", kind: "executed-provider-native", source: "acp-zcode attestation" } }],
    });
    expect(JSON.stringify(result)).not.toMatch(/REQUESTED_/u);
  });

  it("DISCRIMINATOR: distinguishes an absent acp-zcode attestation as no-execution", async () => {
    const scopeTurnId = "bta2647fb7-1-zcode-no-call";
    const result = await readExecutedProfiles({
      thread: { providerId: "acp-zcode", status: "idle", model: "REQUESTED_MODEL_DO_NOT_EMIT", reasoningLevel: "REQUESTED_VARIANT_DO_NOT_EMIT" },
      environment: { path: "/test/project" },
      events: [interrupted("zcode-session", scopeTurnId, "failed")],
      expectedTurnId: scopeTurnId,
    });
    expect(result).toMatchObject({ outcome: "no-execution", coverage: { completedTurns: 1, knownTurns: 0, unknownTurns: 0, noExecutionTurns: 1 }, turns: [{ status: "no-execution" }] });
    expect(result.turns[0].status).not.toBe("unknown");
    expect(JSON.stringify(result)).not.toMatch(/REQUESTED_/u);
  });

  it("GUARD: does not turn malformed acp-zcode attestation output into known evidence", async () => {
    const scopeTurnId = "bta2647fb7-1-zcode-malformed";
    for (const malformed of ["not-json", JSON.stringify({ ...zcodeAttestation, schema: "wrong-schema" })]) {
      const result = await readExecutedProfiles({
        thread: { providerId: "acp-zcode", status: "idle" },
        environment: { path: "/test/project" },
        events: zcodeEvents("zcode-session", scopeTurnId, malformed),
        expectedTurnId: scopeTurnId,
      });
      expect(result).toMatchObject({ outcome: "unknown", coverage: { completedTurns: 1, knownTurns: 0, unknownTurns: 1, noExecutionTurns: 0 }, turns: [{ status: "unknown", reason: "acp-zcode attestation item is malformed or unparseable" }] });
    }
  });

  it("GUARD: treats whitespace-only acp-zcode identity fields as unknown", async () => {
    const scopeTurnId = "bta2647fb7-1-zcode-blank-identity";
    const result = await readExecutedProfiles({
      thread: { providerId: "acp-zcode", status: "idle" },
      environment: { path: "/test/project" },
      events: zcodeEvents("zcode-session", scopeTurnId, JSON.stringify({
        ...zcodeAttestation,
        providerId: " ",
        modelId: "\t",
        variant: "\n",
      })),
      expectedTurnId: scopeTurnId,
    });
    expect(result).toMatchObject({
      outcome: "unknown",
      coverage: { completedTurns: 1, knownTurns: 0, unknownTurns: 1, noExecutionTurns: 0 },
      turns: [{ status: "unknown", reason: "acp-zcode attestation item is malformed or unparseable" }],
    });
  });

  it("REGRESSION: preserves Codex and Pi native output shapes", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const codexSession = "018cc251-f400-7000-8000-000000000000";
    const codexTurn = "123e4567-e89b-42d3-a456-426614174000";
    jsonl(join(home, ".codex", "sessions", "2024", "01", "01", `rollout-${codexSession}.jsonl`), [
      { type: "session_meta", payload: { id: codexSession, originator: "bb", cwd: "/test/project" } },
      { type: "turn_context", payload: { turn_id: codexTurn, model: "gpt-5.6-sol", effort: "medium" } },
    ]);
    const codex = await readExecutedProfiles({ thread: { providerId: "codex", status: "idle" }, environment: { path: "/test/project" }, events: [completion(codexSession, codexTurn)], home });
    expect(JSON.stringify(codex)).toBe(JSON.stringify({ outcome: "known", coverage: { completedTurns: 1, knownTurns: 1, unknownTurns: 0, observedOnlyTurns: 0 }, turns: [{ eventId: `event-${codexTurn}`, eventSeq: 10, checkpointId: codexTurn, providerThreadId: codexSession, scopeTurnId: null, status: "known", executedProfile: { providerId: "codex", model: "gpt-5.6-sol", reasoningLevel: "medium", kind: "executed-provider-native", source: "codex turn_context" } }] }));

    const piSession = "pi-session";
    jsonl(piBridgeLog(home, piSession), [
      { type: "session", id: "unrelated-session-header", cwd: "/test/project" },
      { type: "thinking_level_change", id: "reasoning", parentId: null, thinkingLevel: "high" },
      { type: "message", id: "assistant", parentId: "reasoning", message: { role: "assistant", provider: "kimi-coding", model: "k3" } },
    ]);
    const pi = await readExecutedProfiles({ thread: { providerId: "pi" }, environment: { path: "/test/project" }, events: [completion(piSession, "assistant")], home });
    expect(JSON.stringify(pi)).toBe(JSON.stringify({ outcome: "known", coverage: { completedTurns: 1, knownTurns: 1, unknownTurns: 0, observedOnlyTurns: 0 }, turns: [{ eventId: "event-assistant", eventSeq: 10, checkpointId: "assistant", providerThreadId: piSession, scopeTurnId: null, status: "known", executedProfile: { providerId: "pi", model: "kimi-coding/k3", reasoningLevel: "high", kind: "executed-provider-native", source: "Pi assistant envelope and thinking state" } }] }));
  });

  it("does not call an idle snapshot known after a turn starts during pagination", async () => {
    const events = activeEvents("idle-then-active");
    const result = await readExecutedProfiles({
      thread: { providerId: "codex", status: "idle" },
      environment: { path: "/test/project" },
      events,
    });
    expect(environmentDependentFromEvents({ providerId: "codex", status: "idle" }, events)).toBe(true);
    expect(result.outcome).not.toBe("known");
  });

  it("filters completed readback to one exact BB turn", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "018cc251-f400-7000-8000-000000000000";
    const turnA = "123e4567-e89b-42d3-a456-426614174000";
    const turnB = "123e4567-e89b-42d3-a456-426614174001";
    const events = [...stoppedEvents(providerThreadId, turnA, "completed"), ...stoppedEvents(providerThreadId, turnB, "completed")];
    jsonl(join(home, ".codex", "sessions", "2024", "01", "01", `rollout-${providerThreadId}.jsonl`), [
      { type: "session_meta", payload: { id: providerThreadId, originator: "bb", cwd: "/test/project" } },
      { type: "turn_context", payload: { turn_id: turnA, model: "gpt-a", effort: "medium" } },
      { type: "turn_context", payload: { turn_id: turnB, model: "gpt-b", effort: "medium" } },
    ]);
    const expected = await readExecutedProfiles({
      thread: { providerId: "codex", status: "idle" },
      environment: { path: "/test/project" },
      events,
      expectedTurnId: `bta2647fb7-1-${turnB}`,
      home,
    });
    expect(expected).toMatchObject({ outcome: "known", coverage: { completedTurns: 1, knownTurns: 1 }, turns: [{ scopeTurnId: `bta2647fb7-1-${turnB}`, executedProfile: { model: "gpt-b" } }] });
    await expect(readExecutedProfiles({
      thread: { providerId: "codex", status: "idle" },
      environment: { path: "/test/project" },
      events,
      expectedTurnId: "foreign-turn",
      home,
    })).resolves.toMatchObject({ outcome: "unknown", reason: expect.stringContaining("found 0") });
  });

  it("DISCRIMINATOR: reads the active Codex turn from its provider-native rollout", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "018cc251-f400-7000-8000-000000000000";
    jsonl(join(home, ".codex", "sessions", "2024", "01", "01", `rollout-${providerThreadId}.jsonl`), [
      { type: "session_meta", payload: { id: providerThreadId, originator: "bb", cwd: "/test/project" } },
      { type: "turn_context", timestamp: "2026-08-20T00:00:10.500Z", payload: { turn_id: "active-turn", model: "gpt-5.6-sol", effort: "medium" } },
    ]);
    const result = await readExecutedProfiles({
      thread: { providerId: "codex", status: "active" },
      environment: { path: "/test/project" },
      events: activeEvents(providerThreadId),
      home,
    });
    expect(result).toMatchObject({
      outcome: "known",
      coverage: { activeTurns: 1, completedTurns: 0, knownTurns: 1, unknownTurns: 0 },
      turns: [{
        phase: "active",
        status: "known",
        executedProfile: { providerId: "codex", model: "gpt-5.6-sol", reasoningLevel: "medium", kind: "executed-provider-native" },
      }],
    });
  });

  it("DISCRIMINATOR: reads an active Codex continuation from its native turn context", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "018cc251-f400-7000-8000-000000000000";
    const nativeTurnId = "123e4567-e89b-42d3-a456-426614174000";
    jsonl(join(home, ".codex", "sessions", "2024", "01", "01", `rollout-${providerThreadId}.jsonl`), [
      { type: "session_meta", payload: { id: providerThreadId, originator: "bb", cwd: "/test/project" } },
      { type: "turn_context", timestamp: "2026-08-20T00:00:14.500Z", payload: { turn_id: nativeTurnId, model: "gpt-5.6-sol", effort: "medium" } },
    ]);
    const result = await readExecutedProfiles({
      thread: { providerId: "codex", status: "active" },
      environment: { path: "/test/project" },
      events: continuationEvents(providerThreadId, nativeTurnId),
      home,
    });
    expect(result).toMatchObject({
      outcome: "known",
      coverage: { activeTurns: 1, completedTurns: 0, knownTurns: 1, unknownTurns: 0 },
      turns: [{ phase: "active", status: "known", executedProfile: { providerId: "codex", model: "gpt-5.6-sol", reasoningLevel: "medium" } }],
    });
  });

  it("GUARD: refuses zero-input active turns without a prior terminal turn", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "018cc251-f400-7000-8000-000000000000";
    const nativeTurnId = "123e4567-e89b-42d3-a456-426614174000";
    const events = continuationEvents(providerThreadId, nativeTurnId).filter((event) => event.id !== "event-first-completed");
    jsonl(join(home, ".codex", "sessions", "2024", "01", "01", `rollout-${providerThreadId}.jsonl`), [
      { type: "session_meta", payload: { id: providerThreadId, originator: "bb", cwd: "/test/project" } },
      { type: "turn_context", timestamp: "2026-08-20T00:00:14.500Z", payload: { turn_id: nativeTurnId, model: "DO_NOT_ACCEPT", effort: "medium" } },
    ]);
    const result = await readExecutedProfiles({
      thread: { providerId: "codex", status: "active" },
      environment: { path: "/test/project" },
      events,
      home,
    });
    expect(result).toMatchObject({
      outcome: "unknown",
      coverage: { activeTurns: 1, knownTurns: 0, unknownTurns: 1 },
      turns: [],
      reason: "BB active turn input correlation is missing or ambiguous",
    });
    expect(JSON.stringify(result)).not.toMatch(/DO_NOT_ACCEPT|executedProfile/u);
  });

  it("GUARD: refuses zero-input non-continuation turns with another request accepted", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "018cc251-f400-7000-8000-000000000000";
    const nativeTurnId = "123e4567-e89b-42d3-a456-426614174000";
    const scope = { kind: "turn", turnId: `bta2647fb7-1-${nativeTurnId}` };
    const priorScope = { kind: "turn", turnId: "bta2647fb7-1-prior-turn" };
    const events = [
      { id: "event-prior-started", seq: 8, type: "turn/started", data: { providerThreadId }, scope: priorScope },
      { id: "event-prior-completed", seq: 9, type: "turn/completed", data: { status: "completed", providerThreadId, providerCheckpointId: "prior-turn" }, scope: priorScope },
      { id: "event-older-requested", seq: 10, type: "client/turn/requested", data: { requestId: "request-older" }, createdAt: Date.parse("2026-08-20T00:00:10.000Z") },
      { id: "event-current-requested", seq: 11, type: "client/turn/requested", data: { requestId: "request-current" }, createdAt: Date.parse("2026-08-20T00:00:11.000Z") },
      { id: "event-current-started", seq: 12, type: "turn/started", data: { providerThreadId }, scope, createdAt: Date.parse("2026-08-20T00:00:12.000Z") },
      { id: "event-older-accepted", seq: 13, type: "turn/input/accepted", data: { providerThreadId, clientRequestId: "request-older" }, scope, createdAt: Date.parse("2026-08-20T00:00:12.000Z") },
    ];
    jsonl(join(home, ".codex", "sessions", "2024", "01", "01", `rollout-${providerThreadId}.jsonl`), [
      { type: "session_meta", payload: { id: providerThreadId, originator: "bb", cwd: "/test/project" } },
      { type: "turn_context", timestamp: "2026-08-20T00:00:12.500Z", payload: { turn_id: nativeTurnId, model: "DO_NOT_ACCEPT", effort: "medium" } },
    ]);
    const result = await readExecutedProfiles({
      thread: { providerId: "codex", status: "active" },
      environment: { path: "/test/project" },
      events,
      home,
    });
    expect(result).toMatchObject({
      outcome: "unknown",
      coverage: { activeTurns: 1, knownTurns: 0, unknownTurns: 1 },
      turns: [],
      reason: "BB active turn input correlation is missing or ambiguous",
    });
    expect(JSON.stringify(result)).not.toMatch(/DO_NOT_ACCEPT|executedProfile/u);
  });

  it("GUARD: does not reuse a prior native profile when a continuation turn has no native turn context", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "018cc251-f400-7000-8000-000000000000";
    const nativeTurnId = "123e4567-e89b-42d3-a456-426614174000";
    jsonl(join(home, ".codex", "sessions", "2024", "01", "01", `rollout-${providerThreadId}.jsonl`), [
      { type: "session_meta", payload: { id: providerThreadId, originator: "bb", cwd: "/test/project" } },
      { type: "turn_context", timestamp: "2026-08-20T00:00:14.500Z", payload: { turn_id: "first-turn", model: "STALE_PROFILE", effort: "high" } },
    ]);
    const result = await readExecutedProfiles({
      thread: { providerId: "codex", status: "active" },
      environment: { path: "/test/project" },
      events: continuationEvents(providerThreadId, nativeTurnId),
      home,
    });
    expect(result).toMatchObject({ outcome: "unknown", turns: [{ phase: "active", status: "unknown" }] });
    expect(JSON.stringify(result)).not.toMatch(/STALE_PROFILE|executedProfile/u);
  });

  it("GUARD: refuses a foreign clientRequestId in an otherwise native continuation turn", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "018cc251-f400-7000-8000-000000000000";
    const nativeTurnId = "123e4567-e89b-42d3-a456-426614174000";
    const events = continuationEvents(providerThreadId, nativeTurnId);
    events.push({
      id: "event-foreign-accepted",
      seq: 15,
      type: "turn/input/accepted",
      data: { providerThreadId, clientRequestId: "foreign-request" },
      scope: events.at(-1).scope,
      createdAt: Date.parse("2026-08-20T00:00:15.000Z"),
    });
    jsonl(join(home, ".codex", "sessions", "2024", "01", "01", `rollout-${providerThreadId}.jsonl`), [
      { type: "session_meta", payload: { id: providerThreadId, originator: "bb", cwd: "/test/project" } },
      { type: "turn_context", timestamp: "2026-08-20T00:00:14.500Z", payload: { turn_id: nativeTurnId, model: "DO_NOT_ACCEPT", effort: "medium" } },
    ]);
    const result = await readExecutedProfiles({
      thread: { providerId: "codex", status: "active" },
      environment: { path: "/test/project" },
      events,
      home,
    });
    expect(result).toMatchObject({ outcome: "unknown", reason: "BB active turn input correlation is missing or ambiguous" });
    expect(JSON.stringify(result)).not.toMatch(/DO_NOT_ACCEPT|executedProfile/u);
  });

  it("DISCRIMINATOR: correlates the current request when multiple legitimate inputs share an active turn", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "018cc251-f400-7000-8000-000000000000";
    const nativeTurnId = "123e4567-e89b-42d3-a456-426614174000";
    const scope = { kind: "turn", turnId: `bta2647fb7-1-${nativeTurnId}` };
    const events = [
      { id: "event-older-requested", seq: 9, type: "client/turn/requested", data: { requestId: "request-older" }, createdAt: Date.parse("2026-08-20T00:00:09.000Z") },
      { id: "event-current-requested", seq: 10, type: "client/turn/requested", data: { requestId: "request-current" }, createdAt: Date.parse("2026-08-20T00:00:10.000Z") },
      { id: "event-current-started", seq: 11, type: "turn/started", data: { providerThreadId }, scope, createdAt: Date.parse("2026-08-20T00:00:11.000Z") },
      { id: "event-older-accepted", seq: 12, type: "turn/input/accepted", data: { providerThreadId, clientRequestId: "request-older" }, scope, createdAt: Date.parse("2026-08-20T00:00:11.000Z") },
      { id: "event-current-accepted", seq: 13, type: "turn/input/accepted", data: { providerThreadId, clientRequestId: "request-current" }, scope, createdAt: Date.parse("2026-08-20T00:00:11.000Z") },
    ];
    jsonl(join(home, ".codex", "sessions", "2024", "01", "01", `rollout-${providerThreadId}.jsonl`), [
      { type: "session_meta", payload: { id: providerThreadId, originator: "bb", cwd: "/test/project" } },
      { type: "turn_context", timestamp: "2026-08-20T00:00:11.500Z", payload: { turn_id: nativeTurnId, model: "gpt-current", effort: "medium" } },
    ]);
    const result = await readExecutedProfiles({
      thread: { providerId: "codex", status: "active" },
      environment: { path: "/test/project" },
      events,
      home,
    });
    expect(result).toMatchObject({ outcome: "known", turns: [{ status: "known", executedProfile: { model: "gpt-current" } }] });
  });

  it("DISCRIMINATOR: ignores a queued input and resolves a stopped Codex turn from its BB scope", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "018cc251-f400-7000-8000-000000000000";
    const nativeTurnId = "123e4567-e89b-42d3-a456-426614174000";
    const events = [
      ...activeEvents(providerThreadId, nativeTurnId),
      { id: "event-queued-request", seq: 20, type: "client/turn/requested", data: { requestId: "request-queued" } },
      { id: "event-queued-accepted", seq: 21, type: "turn/input/accepted", data: { providerThreadId, clientRequestId: "request-queued" }, scope: { kind: "turn", turnId: `bta2647fb7-1-${nativeTurnId}` } },
    ];
    jsonl(join(home, ".codex", "sessions", "2024", "01", "01", `rollout-${providerThreadId}.jsonl`), [
      { type: "session_meta", payload: { id: providerThreadId, originator: "bb", cwd: "/test/project" } },
      { type: "turn_context", timestamp: "2026-08-20T00:00:10.500Z", payload: { turn_id: nativeTurnId, model: "gpt-stopped", effort: "medium" } },
    ]);
    const active = await readExecutedProfiles({
      thread: { providerId: "codex", status: "active" },
      environment: { path: "/test/project" },
      events,
      home,
    });
    expect(active).toMatchObject({ outcome: "known", coverage: { activeTurns: 1, knownTurns: 1 } });

    const stopped = await readExecutedProfiles({
      thread: { providerId: "codex", status: "idle" },
      environment: { path: "/test/project" },
      events: stoppedEvents(providerThreadId, nativeTurnId),
      home,
    });
    expect(stopped).toMatchObject({
      outcome: "known",
      coverage: { completedTurns: 1, knownTurns: 1, unknownTurns: 0 },
      turns: [{ status: "known", executedProfile: { model: "gpt-stopped", reasoningLevel: "medium" } }],
    });
  });

  it("GUARD MULTIPLE_DATE_LOGS: rejects matching Codex logs across adjacent writer-date directories", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "018cc251-f400-7000-8000-000000000000";
    const nativeTurnId = "123e4567-e89b-42d3-a456-426614174000";
    const sessionMeta = { type: "session_meta", payload: { id: providerThreadId, originator: "bb", cwd: "/test/project" } };
    jsonl(join(home, ".codex", "sessions", "2024", "01", "01", `rollout-${providerThreadId}.jsonl`), [
      sessionMeta,
      { type: "turn_context", payload: { turn_id: nativeTurnId, model: "gpt-target", effort: "medium" } },
    ]);
    jsonl(join(home, ".codex", "sessions", "2023", "12", "31", `rollout-adjacent-${providerThreadId}.jsonl`), [
      sessionMeta,
      { type: "turn_context", payload: { turn_id: nativeTurnId, model: "FOREIGNLY_ADMITTED_MODEL", effort: "medium" } },
    ]);
    const result = await readExecutedProfiles({
      thread: { providerId: "codex", status: "idle" },
      environment: { path: "/test/project" },
      events: stoppedEvents(providerThreadId, nativeTurnId),
      home,
    });
    expect(result).toMatchObject({ outcome: "unknown", reason: "expected one Codex session log, found 2" });
    expect(JSON.stringify(result)).not.toMatch(/FOREIGNLY_ADMITTED_MODEL|executedProfile/u);
  });

  it("GUARD CONFLICTING_SESSION_META: rejects foreign and matching native metadata in one log", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "018cc251-f400-7000-8000-000000000000";
    const nativeTurnId = "123e4567-e89b-42d3-a456-426614174000";
    jsonl(join(home, ".codex", "sessions", "2024", "01", "01", `rollout-${providerThreadId}.jsonl`), [
      { type: "session_meta", payload: { id: providerThreadId, originator: "bb", cwd: "/other/project" } },
      { type: "session_meta", payload: { id: providerThreadId, originator: "bb", cwd: "/test/project" } },
      { type: "turn_context", payload: { turn_id: nativeTurnId, model: "FOREIGNLY_ADMITTED_MODEL", effort: "medium" } },
    ]);
    const result = await readExecutedProfiles({
      thread: { providerId: "codex", status: "idle" },
      environment: { path: "/test/project" },
      events: stoppedEvents(providerThreadId, nativeTurnId),
      home,
    });
    expect(result).toMatchObject({ outcome: "unknown", reason: "Codex session_meta does not match the BB session and exact environment path" });
    expect(JSON.stringify(result)).not.toMatch(/FOREIGNLY_ADMITTED_MODEL|executedProfile/u);
  });

  it("GUARD NONTERMINAL_STATUS: excludes running status while accepting failed terminal status", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "018cc251-f400-7000-8000-000000000000";
    const nativeTurnId = "123e4567-e89b-42d3-a456-426614174000";
    jsonl(join(home, ".codex", "sessions", "2024", "01", "01", `rollout-${providerThreadId}.jsonl`), [
      { type: "session_meta", payload: { id: providerThreadId, originator: "bb", cwd: "/test/project" } },
      { type: "turn_context", payload: { turn_id: nativeTurnId, model: "gpt-failed", effort: "medium" } },
    ]);
    const running = await readExecutedProfiles({
      thread: { providerId: "codex", status: "idle" },
      environment: { path: "/test/project" },
      events: stoppedEvents(providerThreadId, nativeTurnId, "running"),
      home,
    });
    expect(running).toMatchObject({ outcome: "unknown", coverage: { completedTurns: 0, knownTurns: 0 } });
    expect(JSON.stringify(running)).not.toMatch(/gpt-failed|executedProfile/u);

    const failed = await readExecutedProfiles({
      thread: { providerId: "codex", status: "idle" },
      environment: { path: "/test/project" },
      events: stoppedEvents(providerThreadId, nativeTurnId, "failed"),
      home,
    });
    expect(failed).toMatchObject({ outcome: "known", coverage: { completedTurns: 1, knownTurns: 1 } });
  });

  it("GUARD FOREIGN_SCOPE_PREFIX: rejects a UUID suffix without the BB native Codex scope shape", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "018cc251-f400-7000-8000-000000000000";
    const nativeTurnId = "123e4567-e89b-42d3-a456-426614174000";
    jsonl(join(home, ".codex", "sessions", "2024", "01", "01", `rollout-${providerThreadId}.jsonl`), [
      { type: "session_meta", payload: { id: providerThreadId, originator: "bb", cwd: "/test/project" } },
      { type: "turn_context", payload: { turn_id: nativeTurnId, model: "FOREIGNLY_ADMITTED_MODEL", effort: "medium" } },
    ]);
    const result = await readExecutedProfiles({
      thread: { providerId: "codex", status: "idle" },
      environment: { path: "/test/project" },
      events: stoppedEvents(providerThreadId, nativeTurnId, "interrupted", "foreign-scope"),
      home,
    });
    expect(result).toMatchObject({ outcome: "unknown", coverage: { completedTurns: 1, knownTurns: 0 } });
    expect(JSON.stringify(result)).not.toMatch(/FOREIGNLY_ADMITTED_MODEL|executedProfile/u);
  });

  it("GUARD: stopped Codex scope correlation requires the exact native session", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "018cc251-f400-7000-8000-000000000000";
    const nativeTurnId = "123e4567-e89b-42d3-a456-426614174000";
    jsonl(join(home, ".codex", "sessions", "2024", "01", "01", `rollout-${providerThreadId}.jsonl`), [
      { type: "session_meta", payload: { id: providerThreadId, originator: "bb", cwd: "/other/project" } },
      { type: "turn_context", payload: { turn_id: nativeTurnId, model: "DO_NOT_EMIT", effort: "medium" } },
    ]);
    const result = await readExecutedProfiles({
      thread: { providerId: "codex", status: "idle" },
      environment: { path: "/test/project" },
      events: stoppedEvents(providerThreadId, nativeTurnId),
      home,
    });
    expect(result).toMatchObject({ outcome: "unknown", reason: "Codex session_meta does not match the BB session and exact environment path" });
    expect(JSON.stringify(result)).not.toMatch(/DO_NOT_EMIT|other\/project|executedProfile/u);
  });

  it("GUARD: stopped Codex scope correlation never substitutes requested or default profile fields", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "018cc251-f400-7000-8000-000000000000";
    const nativeTurnId = "123e4567-e89b-42d3-a456-426614174000";
    const result = await readExecutedProfiles({
      thread: {
        providerId: "codex",
        status: "idle",
        requestedModel: "REQUESTED_MODEL_DO_NOT_EMIT",
        requestedReasoningLevel: "REQUESTED_REASONING_DO_NOT_EMIT",
        model: "DEFAULT_MODEL_DO_NOT_EMIT",
        reasoningLevel: "DEFAULT_REASONING_DO_NOT_EMIT",
      },
      environment: { path: "/test/project" },
      events: stoppedEvents(providerThreadId, nativeTurnId),
      home,
    });
    expect(result).toMatchObject({ outcome: "unknown", coverage: { completedTurns: 1, knownTurns: 0 } });
    expect(JSON.stringify(result)).not.toMatch(/REQUESTED_|DEFAULT_|executedProfile/u);
  });

  it("DISCRIMINATOR: finds a Codex rollout in the adjacent writer-date directory", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "019aa3c6-e964-7c32-8882-42f49fd63f0a";
    jsonl(join(home, ".codex", "sessions", "2025", "11", "20", `rollout-${providerThreadId}.jsonl`), [
      { type: "session_meta", payload: { id: providerThreadId, originator: "bb", cwd: "/test/project" } },
      { type: "turn_context", timestamp: "2026-08-20T00:00:10.500Z", payload: { turn_id: "active-turn", model: "gpt-test", effort: "medium" } },
    ]);
    const result = await readExecutedProfiles({
      thread: { providerId: "codex", status: "active" },
      environment: { path: "/test/project" },
      events: activeEvents(providerThreadId),
      home,
    });
    expect(result).toMatchObject({ outcome: "known", turns: [{ status: "known", executedProfile: { model: "gpt-test", reasoningLevel: "medium" } }] });
  });

  it("GUARD: reads the active Claude profile from its native session surface", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const claudeSession = "123e4567-e89b-42d3-a456-426614174000";
    jsonl(join(home, ".claude", "projects", "-test-project", `${claudeSession}.jsonl`), [
      { type: "assistant", timestamp: "2026-08-20T00:00:10.500Z", uuid: "active-claude", effort: "medium", message: { model: "claude-opus-5[1m]" } },
    ]);
    const claudeResult = await readExecutedProfiles({
      thread: { providerId: "claude-code", status: "active" },
      environment: { path: "/test/project" },
      events: activeEvents(claudeSession),
      home,
    });
    expect(claudeResult).toMatchObject({ outcome: "known", turns: [{ phase: "active", executedProfile: { model: "claude-opus-5[1m]", reasoningLevel: "medium" } }] });
  });

  it("DISCRIMINATOR: reads active Pi evidence from the BB bridge filename, not the unrelated session header id", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "pi-thread-active";
    jsonl(piBridgeLog(home, providerThreadId), [
      { type: "session", id: "unrelated-session-header", cwd: "/test/project" },
      { type: "model_change", id: "00000001", parentId: null, provider: "kimi-coding", modelId: "k3-256k" },
      { type: "thinking_level_change", id: "00000002", parentId: "00000001", thinkingLevel: "high" },
      { type: "message", id: "00000003", parentId: "00000002", timestamp: "2026-08-20T00:00:10.500Z", message: { role: "assistant", provider: "kimi-coding", model: "k3" } },
    ]);
    const piResult = await readExecutedProfiles({
      thread: { providerId: "pi", status: "active" },
      environment: { path: "/test/project" },
      events: activeEvents(providerThreadId),
      home,
    });
    expect(piResult).toMatchObject({
      outcome: "known",
      turns: [{ phase: "active", selectionMismatch: true, executedProfile: { model: "kimi-coding/k3", reasoningLevel: "high" } }],
    });
    expect(JSON.stringify(piResult)).not.toContain("k3-256k");
  });

  it("GUARD: refuses a stale Pi assistant envelope before the active BB turn request", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "pi-stale-envelope";
    jsonl(piBridgeLog(home, providerThreadId), [
      { type: "session", id: "unrelated-session-header", cwd: "/test/project" },
      { type: "thinking_level_change", id: "stale-reasoning", parentId: null, thinkingLevel: "high" },
      { type: "message", id: "stale-assistant", parentId: "stale-reasoning", timestamp: "2026-08-20T00:00:09.000Z", message: { role: "assistant", provider: "kimi-coding", model: "STALE_PI" } },
    ]);
    const result = await readExecutedProfiles({
      thread: { providerId: "pi", status: "active" },
      environment: { path: "/test/project" },
      events: activeEvents(providerThreadId),
      home,
    });
    expect(result).toMatchObject({
      outcome: "unknown",
      turns: [{ status: "unknown", reason: "active Pi assistant envelope at or after the BB turn request is absent" }],
    });
    expect(JSON.stringify(result)).not.toMatch(/STALE_PI|executedProfile/u);
  });

  it("DISCRIMINATOR: refuses a colliding Pi bridge neighbour when the requested id sanitizes lossily", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const requestedId = "pi/thread";
    const foreignId = "pi:thread";
    expect(requestedId).not.toBe(foreignId);
    expect(piBridgeLog(home, requestedId)).toBe(piBridgeLog(home, foreignId));
    jsonl(piBridgeLog(home, foreignId), [
      { type: "session", id: "unrelated-session-header", cwd: "/test/project" },
      { type: "thinking_level_change", id: "foreign-reasoning", parentId: null, thinkingLevel: "high" },
      { type: "message", id: "foreign-assistant", parentId: "foreign-reasoning", timestamp: "2026-08-20T00:00:10.500Z", message: { role: "assistant", provider: "FOREIGN_PROVIDER", model: "FOREIGN_MODEL" } },
    ]);
    const result = await readExecutedProfiles({
      thread: { providerId: "pi", status: "active" },
      environment: { path: "/test/project" },
      events: activeEvents(requestedId),
      home,
    });
    expect(result).toMatchObject({ outcome: "unknown", reason: "active BB turn: Pi provider session id requires lossy filename sanitization" });
    expect(JSON.stringify(result)).not.toMatch(/FOREIGN_PROVIDER|FOREIGN_MODEL|executedProfile/u);
  });

  it("GUARD: reports Pi model evidence while marking conflicting turn reasoning unknown", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "pi-reasoning-change";
    jsonl(piBridgeLog(home, providerThreadId), [
      { type: "session", id: "unrelated-session-header", cwd: "/test/project" },
      { type: "thinking_level_change", id: "00000001", parentId: null, thinkingLevel: "high" },
      { type: "message", id: "00000002", parentId: "00000001", timestamp: "2026-08-20T00:00:10.500Z", message: { role: "assistant", provider: "kimi-coding", model: "k3" } },
      { type: "thinking_level_change", id: "00000003", parentId: "00000002", thinkingLevel: "medium" },
      { type: "message", id: "00000004", parentId: "00000003", timestamp: "2026-08-20T00:00:11.500Z", message: { role: "assistant", provider: "kimi-coding", model: "k3" } },
    ]);
    const result = await readExecutedProfiles({
      thread: { providerId: "pi", status: "active" },
      environment: { path: "/test/project" },
      events: activeEvents(providerThreadId),
      home,
    });
    expect(result).toMatchObject({
      outcome: "unknown",
      coverage: { activeTurns: 1, knownTurns: 0, unknownTurns: 1 },
      turns: [{
        status: "unknown",
        reason: "Pi reasoningLevel evidence is absent or ambiguous",
        unknownElements: ["reasoningLevel"],
        executedProfile: { providerId: "pi", model: "kimi-coding/k3", kind: "executed-provider-native", source: "Pi assistant envelope" },
      }],
    });
    expect(result.turns[0].executedProfile).not.toHaveProperty("reasoningLevel");
  });

  it("GUARD: refuses ambiguous or foreign active Codex sessions", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "018cc251-f400-7000-8000-000000000000";
    jsonl(join(home, ".codex", "sessions", "2024", "01", "01", `rollout-${providerThreadId}.jsonl`), [
      { type: "session_meta", payload: { id: providerThreadId, originator: "bb", cwd: "/other/project" } },
      { type: "turn_context", timestamp: "2026-08-20T00:00:10.500Z", payload: { turn_id: "active-turn", model: "DO_NOT_EMIT", effort: "medium" } },
    ]);
    const result = await readExecutedProfiles({
      thread: { providerId: "codex", status: "active" },
      environment: { path: "/test/project" },
      events: activeEvents(providerThreadId),
      home,
    });
    expect(result).toMatchObject({ outcome: "unknown", reason: "active BB turn: Codex session_meta does not match the BB session and exact environment path" });
    expect(JSON.stringify(result)).not.toMatch(/DO_NOT_EMIT|other\/project|executedProfile/u);

    const ambiguousHome = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    for (const prefix of ["rollout-a", "rollout-b"]) {
      jsonl(join(ambiguousHome, ".codex", "sessions", "2024", "01", "01", `${prefix}-${providerThreadId}.jsonl`), [
        { type: "session_meta", payload: { id: providerThreadId, originator: "bb", cwd: "/test/project" } },
        { type: "turn_context", timestamp: "2026-08-20T00:00:10.500Z", payload: { turn_id: prefix, model: "DO_NOT_EMIT", effort: "medium" } },
      ]);
    }
    const ambiguous = await readExecutedProfiles({
      thread: { providerId: "codex", status: "active" },
      environment: { path: "/test/project" },
      events: activeEvents(providerThreadId),
      home: ambiguousHome,
    });
    expect(ambiguous).toMatchObject({ outcome: "unknown", reason: "active BB turn: expected one Codex session log, found 2" });
    expect(JSON.stringify(ambiguous)).not.toMatch(/DO_NOT_EMIT|executedProfile/u);
  });

  it("DISCRIMINATOR: refuses stale Codex and Claude profiles that predate the active BB turn request", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const codexSession = "018cc251-f400-7000-8000-000000000000";
    jsonl(join(home, ".codex", "sessions", "2024", "01", "01", `rollout-${codexSession}.jsonl`), [
      { type: "session_meta", payload: { id: codexSession, originator: "bb", cwd: "/test/project" } },
      { type: "turn_context", timestamp: "2026-08-20T00:00:09.000Z", payload: { turn_id: "prior-turn", model: "STALE_CODEX", effort: "high" } },
    ]);
    const codexResult = await readExecutedProfiles({
      thread: { providerId: "codex", status: "active" },
      environment: { path: "/test/project" },
      events: activeEvents(codexSession, "current-turn"),
      home,
    });
    expect(codexResult).toMatchObject({ outcome: "unknown", turns: [{ phase: "active", status: "unknown" }] });
    expect(JSON.stringify(codexResult)).not.toMatch(/STALE_CODEX|executedProfile/u);

    const claudeSession = "123e4567-e89b-42d3-a456-426614174000";
    jsonl(join(home, ".claude", "projects", "-test-project", `${claudeSession}.jsonl`), [
      { type: "assistant", timestamp: "2026-08-20T00:00:09.000Z", uuid: "prior-turn", effort: "high", message: { model: "STALE_CLAUDE[1m]" } },
    ]);
    const claudeResult = await readExecutedProfiles({
      thread: { providerId: "claude-code", status: "active" },
      environment: { path: "/test/project" },
      events: activeEvents(claudeSession),
      home,
    });
    expect(claudeResult).toMatchObject({ outcome: "unknown", turns: [{ phase: "active", status: "unknown" }] });
    expect(JSON.stringify(claudeResult)).not.toMatch(/STALE_CLAUDE|executedProfile/u);
  });

  it("DISCRIMINATOR: refuses foreign Pi bridge sessions and honours the bridge-directory override", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const override = join(home, "pi-override");
    jsonl(piBridgeLog(home, "foreign-session", override), [
      { type: "session", id: "unrelated-header", cwd: "/test/project" },
      { type: "thinking_level_change", id: "foreign-reasoning", parentId: null, thinkingLevel: "high" },
      { type: "message", id: "foreign-message", parentId: "foreign-reasoning", timestamp: "2026-08-20T00:00:11.000Z", message: { role: "assistant", provider: "WRONG_PROVIDER", model: "WRONG_SESSION" } },
    ]);
    const result = await readExecutedProfiles({
      thread: { providerId: "pi", status: "active" },
      environment: { path: "/test/project" },
      events: activeEvents("target-session"),
      home,
      env: { BB_PI_BRIDGE_SESSION_DIR: override },
    });
    expect(result).toMatchObject({ outcome: "unknown", reason: "active BB turn: expected the exact Pi bridge session log, found 0" });
    expect(JSON.stringify(result)).not.toMatch(/WRONG_PROVIDER|WRONG_SESSION|executedProfile/u);

    jsonl(piBridgeLog(home, "target-session", override), [
      { type: "session", id: "another-unrelated-header", cwd: "/test/project" },
      { type: "thinking_level_change", id: "target-reasoning", parentId: null, thinkingLevel: "high" },
      { type: "message", id: "target-message", parentId: "target-reasoning", timestamp: "2026-08-20T00:00:11.000Z", message: { role: "assistant", provider: "kimi-coding", model: "k3" } },
    ]);
    const selected = await readExecutedProfiles({
      thread: { providerId: "pi", status: "active" },
      environment: { path: "/test/project" },
      events: activeEvents("target-session"),
      home,
      env: { BB_PI_BRIDGE_SESSION_DIR: override },
    });
    expect(selected).toMatchObject({ outcome: "known", turns: [{ executedProfile: { model: "kimi-coding/k3", reasoningLevel: "high" } }] });
  });

  it("GUARD: preserves completed Codex correlation and conflict handling", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "018cc251-f400-7000-8000-000000000000";
    jsonl(join(home, ".codex", "sessions", "2024", "01", "01", `rollout-${providerThreadId}.jsonl`), [
      { type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-5.6-sol", effort: "medium" } },
      { type: "turn_context", payload: { turn_id: "turn-2", model: "gpt-5.6-sol", effort: "medium" } },
      { type: "turn_context", payload: { turn_id: "turn-2", model: "gpt-5.6-luna", effort: "medium" } },
    ]);
    jsonl(join(home, ".codex", "sessions", "2023", "12", "31", "rollout-other-provider.jsonl"), [{ not: "the target session" }]);
    const result = await readExecutedProfiles({
      thread: { providerId: "codex" },
      events: [completion(providerThreadId, "turn-1"), completion(providerThreadId, "turn-2")],
      home,
    });
    expect(result).toMatchObject({
      outcome: "partial",
      coverage: { completedTurns: 2, knownTurns: 1, unknownTurns: 1 },
      turns: [
        { status: "known", executedProfile: { providerId: "codex", model: "gpt-5.6-sol", reasoningLevel: "medium", kind: "executed-provider-native" } },
        { status: "unknown", reason: "provider-native turn profiles conflict" },
      ],
    });
  });

  it("REGRESSION: keeps the CLI exit code zero for a partial Codex read", () => {
    const root = mkdtempSync(join(tmpdir(), "bb-collab-profile-cli-"));
    const home = join(root, "home");
    const fakeBin = join(root, "bin");
    const fakeBbScript = join(root, "fake-bb.mjs");
    const bb = join(fakeBin, "bb");
    const providerThreadId = "018cc251-f400-7000-8000-000000000000";
    const events = [completion(providerThreadId, "turn-1"), completion(providerThreadId, "turn-2")];
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(fakeBbScript, [
      `const shown = ${JSON.stringify({ thread: { id: "thread-1", projectId: "project-1", providerId: "codex", status: "idle" }, environment: { path: "/test/project" } })};`,
      `const events = ${JSON.stringify(events)};`,
      "if (process.argv[3] === \"show\") console.log(JSON.stringify(shown));",
      "else if (process.argv[3] === \"log\") console.log(JSON.stringify(events));",
      "else process.exit(1);",
    ].join("\n"));
    writeFileSync(bb, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeBbScript)} "$@"\n`);
    chmodSync(bb, 0o755);
    jsonl(join(home, ".codex", "sessions", "2024", "01", "01", `rollout-${providerThreadId}.jsonl`), [
      { type: "session_meta", payload: { id: providerThreadId, originator: "bb", cwd: "/test/project" } },
      { type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-5.6-sol", effort: "medium" } },
      { type: "turn_context", payload: { turn_id: "turn-2", model: "gpt-5.6-sol", effort: "medium" } },
      { type: "turn_context", payload: { turn_id: "turn-2", model: "gpt-5.6-luna", effort: "medium" } },
    ]);
    const result = spawnSync(process.execPath, [
      new URL("../scripts/read-executed-profile.mjs", import.meta.url).pathname,
      "--project", "project-1", "--thread", "thread-1",
    ], { env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH ?? ""}` }, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "partial", coverage: { completedTurns: 2, knownTurns: 1, unknownTurns: 1 } });
  });

  it("DISCRIMINATOR: treats NUL-colliding executed profiles as conflicting", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "018cc251-f400-7000-8000-000000000000";
    jsonl(join(home, ".codex", "sessions", "2024", "01", "01", `rollout-${providerThreadId}.jsonl`), [
      { type: "turn_context", payload: { turn_id: "turn-1", model: "a\0b", effort: "c" } },
      { type: "turn_context", payload: { turn_id: "turn-1", model: "a", effort: "b\0c" } },
    ]);
    const result = await readExecutedProfiles({
      thread: { providerId: "codex" },
      events: [completion(providerThreadId, "turn-1")],
      home,
    });
    expect(result).toMatchObject({ outcome: "unknown", turns: [{ status: "unknown", reason: "provider-native turn profiles conflict" }] });
  });

  it("correlates Claude completion UUIDs to assistant envelopes", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "123e4567-e89b-42d3-a456-426614174000";
    jsonl(join(home, ".claude", "projects", "-test-project", providerThreadId + ".jsonl"), [
      { type: "assistant", uuid: "turn-1", effort: "medium", message: { model: "claude-opus-5" } },
      { type: "assistant", uuid: "turn-1", effort: "medium", message: { model: "claude-opus-5" } },
    ]);
    jsonl(join(home, ".claude", "projects", "-unrelated-project", providerThreadId + ".jsonl"), [{ not: "the target session" }]);
    const result = await readExecutedProfiles({
      thread: { providerId: "claude-code" },
      environment: { path: "/test/project" },
      events: [completion(providerThreadId, "turn-1")],
      home,
    });
    expect(result).toMatchObject({
      outcome: "unknown",
      coverage: { knownTurns: 0, unknownTurns: 1, observedOnlyTurns: 1 },
      turns: [{
        status: "unknown",
        reason: "provider-native model does not establish the exact dispatched SKU or context-window suffix",
        observedProfile: { model: "claude-opus-5", reasoningLevel: "medium" },
      }],
    });
  });

  it("DISCRIMINATOR: walks a completed Pi checkpoint chain and keeps envelope model authoritative over selection", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "pi-session";
    jsonl(piBridgeLog(home, providerThreadId), [
      { type: "session", version: 3, id: "unrelated-session-header", timestamp: "2026-08-20T00:00:00.000Z", cwd: "/test/project" },
      { type: "model_change", id: "00000001", parentId: null, timestamp: "2026-08-20T00:00:01.000Z", provider: "kimi-coding", modelId: "k3-256k" },
      { type: "thinking_level_change", id: "00000002", parentId: "00000001", timestamp: "2026-08-20T00:00:02.000Z", thinkingLevel: "high" },
      { type: "message", id: "00000003", parentId: "00000002", timestamp: "2026-08-20T00:00:03.000Z", message: { role: "assistant", provider: "kimi-coding", model: "k3", usage: { reasoning: 42 }, content: "DO_NOT_EMIT" } },
      { type: "message", id: "00000004", parentId: "00000003", timestamp: "2026-08-20T00:00:04.000Z", message: { role: "toolResult", content: "DO_NOT_EMIT" } },
    ]);
    const result = await readExecutedProfiles({
      thread: { providerId: "pi" },
      environment: { path: "/test/project" },
      events: [completion(providerThreadId, "00000004")],
      home,
    });
    expect(result).toMatchObject({
      outcome: "known",
      coverage: { completedTurns: 1, knownTurns: 1, unknownTurns: 0 },
      turns: [{
        status: "known",
        selectionMismatch: true,
        executedProfile: { providerId: "pi", model: "kimi-coding/k3", reasoningLevel: "high", kind: "executed-provider-native" },
      }],
    });
    expect(JSON.stringify(result)).not.toMatch(/DO_NOT_EMIT|k3-256k/u);
  });

  it("DISCRIMINATOR: returns unknown when a Pi checkpoint parent chain cannot reach an assistant envelope", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    jsonl(piBridgeLog(home, "pi-session"), [
      { type: "session", version: 3, id: "unrelated-session-header", timestamp: "2026-08-20T00:00:00.000Z", cwd: "/test/project" },
      { type: "message", id: "prior-assistant", parentId: null, message: { role: "assistant", provider: "WRONG_PROVIDER", model: "WRONG_MODEL", content: "DO_NOT_EMIT" } },
      { type: "message", id: "current-user", parentId: "prior-assistant", message: { role: "user", content: "DO_NOT_EMIT" } },
      { type: "message", id: "checkpoint-1", parentId: "current-user", message: { role: "toolResult", content: "DO_NOT_EMIT" } },
    ]);
    const result = await readExecutedProfiles({
      thread: { providerId: "pi" },
      environment: { path: "/test/project" },
      events: [completion("pi-session", "checkpoint-1")],
      home,
    });
    expect(result).toMatchObject({
      outcome: "unknown",
      reason: "Pi checkpoint parent chain does not reach an assistant envelope",
      turns: [{ reason: "Pi checkpoint parent chain does not reach an assistant envelope" }],
    });
    expect(JSON.stringify(result)).not.toMatch(/DO_NOT_EMIT|WRONG_PROVIDER|WRONG_MODEL|content/u);
  });

  it("GUARD: preserves Pi's completed-turn refusal when BB omits checkpoint correlation", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    jsonl(piBridgeLog(home, "pi-session"), [
      { type: "session", id: "unrelated-session-header", cwd: "/test/project" },
    ]);
    const result = await readExecutedProfiles({
      thread: { providerId: "pi" },
      environment: { path: "/test/project" },
      events: [completion("pi-session", null)],
      home,
    });
    expect(result).toMatchObject({
      outcome: "unknown",
      reason: "BB completion lacks provider correlation",
      turns: [{ status: "unknown", reason: "BB completion lacks provider correlation" }],
    });
  });

  it("refuses a Pi session whose header names a different cwd", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const path = piBridgeLog(home, "pi-session");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: "123e4567-e89b-42d3-a456-426614174000", timestamp: "2026-08-20T00:00:00.000Z", cwd: "/other/project" })}\n{DO_NOT_EMIT}\n`);
    const result = await readExecutedProfiles({
      thread: { providerId: "pi" },
      environment: { path: "/test/project" },
      events: [completion("pi-session", "00000003")],
      home,
    });
    expect(result).toMatchObject({ outcome: "unknown", reason: "Pi session header does not match the exact BB environment path" });
    expect(JSON.stringify(result)).not.toMatch(/DO_NOT_EMIT|other\/project/u);
  });

  it("GUARD: refuses a non-session Pi header and a crafted traversal id without leakage", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    jsonl(piBridgeLog(home, "pi-session"), [
      { type: "message", id: "not-a-session-header", cwd: "/test/project", message: { role: "assistant", provider: "DO_NOT_EMIT", model: "DO_NOT_EMIT" } },
    ]);
    const badHeader = await readExecutedProfiles({
      thread: { providerId: "pi" },
      environment: { path: "/test/project" },
      events: [completion("pi-session", "not-a-session-header")],
      home,
    });
    expect(badHeader).toMatchObject({ outcome: "unknown", reason: "Pi session header does not match the exact BB environment path" });
    expect(JSON.stringify(badHeader)).not.toMatch(/DO_NOT_EMIT|executedProfile/u);

    const traversal = await readExecutedProfiles({
      thread: { providerId: "pi" },
      environment: { path: "/test/project" },
      events: [completion("../../private-session", "checkpoint")],
      home,
    });
    expect(traversal).toMatchObject({ outcome: "unknown", reason: "Pi provider session id requires lossy filename sanitization" });
    expect(JSON.stringify(traversal)).not.toMatch(/executedProfile/u);
  });

  it("returns unknown when a provider-native log is malformed", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "018cc251-f400-7000-8000-000000000000";
    const path = join(home, ".codex", "sessions", "2024", "01", "01", `rollout-${providerThreadId}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not json}\n");
    const result = await readExecutedProfiles({
      thread: { providerId: "codex" },
      events: [completion(providerThreadId, "turn-1")],
      home,
    });
    expect(result).toMatchObject({ outcome: "unknown", reason: "Codex session log is unreadable" });
  });

  it("treats directory and file symlink escapes as absent without emitting content", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const claudeSession = "123e4567-e89b-42d3-a456-426614174000";
    const outsideDirectory = join(home, "private-other-project");
    jsonl(join(outsideDirectory, `${claudeSession}.jsonl`), [{
      type: "assistant",
      uuid: "turn-1",
      effort: "medium",
      message: { model: "claude-opus-5[1m]", content: [{ type: "text", text: "DO_NOT_EMIT" }] },
    }]);
    const claudeRoot = join(home, ".claude", "projects");
    mkdirSync(claudeRoot, { recursive: true });
    symlinkSync(outsideDirectory, join(claudeRoot, "-test-project"), "dir");

    const claudeResult = await readExecutedProfiles({
      thread: { providerId: "claude-code" },
      environment: { path: "/test/project" },
      events: [completion(claudeSession, "turn-1")],
      home,
    });
    expect(claudeResult).toMatchObject({ outcome: "unknown", reason: "expected one Claude session log, found 0" });
    expect(JSON.stringify(claudeResult)).not.toMatch(/DO_NOT_EMIT|private-other-project|executedProfile/u);

    const codexSession = "018cc251-f400-7000-8000-000000000000";
    const outsideFile = join(home, "private-codex-log.jsonl");
    jsonl(outsideFile, [{ type: "turn_context", payload: { turn_id: "turn-1", model: "DO_NOT_EMIT", effort: "medium" } }]);
    const codexDirectory = join(home, ".codex", "sessions", "2024", "01", "01");
    mkdirSync(codexDirectory, { recursive: true });
    symlinkSync(outsideFile, join(codexDirectory, `rollout-${codexSession}.jsonl`));

    const codexResult = await readExecutedProfiles({
      thread: { providerId: "codex" },
      events: [completion(codexSession, "turn-1")],
      home,
    });
    expect(codexResult).toMatchObject({ outcome: "unknown", reason: "expected one Codex session log, found 0" });
    expect(JSON.stringify(codexResult)).not.toMatch(/DO_NOT_EMIT|private-codex-log|executedProfile/u);

    const piRoot = join(home, ".bb", "pi-bridge-sessions");
    mkdirSync(piRoot, { recursive: true });
    symlinkSync(outsideFile, join(piRoot, "pi-session.jsonl"));
    const piFileResult = await readExecutedProfiles({
      thread: { providerId: "pi" },
      environment: { path: "/pi/file" },
      events: [completion("pi-session", "turn-1")],
      home,
    });
    expect(piFileResult).toMatchObject({ outcome: "unknown", reason: "expected the exact Pi bridge session log, found 0" });
    expect(JSON.stringify(piFileResult)).not.toMatch(/DO_NOT_EMIT|private-codex-log|executedProfile/u);
  });
});
