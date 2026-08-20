import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { readExecutedProfiles } from "../scripts/read-executed-profile.mjs";

const completion = (providerThreadId, checkpointId) => ({
  id: `event-${checkpointId}`,
  seq: 10,
  type: "turn/completed",
  data: { status: "completed", providerThreadId, providerCheckpointId: checkpointId },
});

function activeEvents(providerThreadId, nativeTurnId = "active-turn") {
  const scope = { kind: "turn", turnId: `bb-turn-${nativeTurnId}` };
  return [
    { id: "event-requested", seq: 10, type: "client/turn/requested", data: { requestId: "request-active" }, createdAt: Date.parse("2026-08-20T00:00:10.000Z") },
    { id: "event-active", seq: 11, type: "turn/started", data: { providerThreadId }, scope, createdAt: Date.parse("2026-08-20T00:00:11.000Z") },
    { id: "event-accepted", seq: 12, type: "turn/input/accepted", data: { providerThreadId, clientRequestId: "request-active" }, scope, createdAt: Date.parse("2026-08-20T00:00:11.000Z") },
  ];
}

function jsonl(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

describe("executed profile read-back", () => {
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

  it("GUARD: reads active Claude and Pi profiles from their native session surfaces", async () => {
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

    jsonl(join(home, ".pi", "agent", "sessions", "--test-project--", "2026-08-20T00-00-00-000Z_123e4567-e89b-42d3-a456-426614174000.jsonl"), [
      { type: "session", id: "123e4567-e89b-42d3-a456-426614174000", cwd: "/test/project" },
      { type: "thinking_level_change", id: "00000001", parentId: null, thinkingLevel: "high" },
      { type: "message", id: "00000002", parentId: "00000001", timestamp: "2026-08-20T00:00:10.500Z", message: { role: "assistant", provider: "kimi-coding", model: "k3" } },
    ]);
    const piResult = await readExecutedProfiles({
      thread: { providerId: "pi", status: "active" },
      environment: { path: "/test/project" },
      events: activeEvents("123e4567-e89b-42d3-a456-426614174000"),
      home,
    });
    expect(piResult).toMatchObject({ outcome: "known", turns: [{ phase: "active", executedProfile: { model: "kimi-coding/k3", reasoningLevel: "high" } }] });
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

  it("DISCRIMINATOR: refuses Pi profiles when the BB-named native session is absent", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const directory = join(home, ".pi", "agent", "sessions", "--test-project--");
    for (const [timestamp, sessionId, provider, model] of [
      ["2026-08-20T00-00-00-000Z", "123e4567-e89b-42d3-a456-426614174000", "kimi-coding", "older"],
      ["2026-08-20T01-00-00-000Z", "223e4567-e89b-42d3-a456-426614174000", "WRONG_PROVIDER", "WRONG_SESSION"],
    ]) {
      jsonl(join(directory, `${timestamp}_${sessionId}.jsonl`), [
        { type: "session", id: sessionId, cwd: "/test/project" },
        { type: "thinking_level_change", id: `${sessionId}-reasoning`, parentId: null, thinkingLevel: "high" },
        { type: "message", id: `${sessionId}-message`, parentId: `${sessionId}-reasoning`, timestamp: "2026-08-20T00:00:11.000Z", message: { role: "assistant", provider, model } },
      ]);
    }
    const result = await readExecutedProfiles({
      thread: { providerId: "pi", status: "active" },
      environment: { path: "/test/project" },
      events: activeEvents("323e4567-e89b-42d3-a456-426614174000"),
      home,
    });
    expect(result).toMatchObject({ outcome: "unknown", turns: [{ phase: "active", status: "unknown" }] });
    expect(JSON.stringify(result)).not.toMatch(/WRONG_PROVIDER|WRONG_SESSION|executedProfile/u);

    const selected = await readExecutedProfiles({
      thread: { providerId: "pi", status: "active" },
      environment: { path: "/test/project" },
      events: activeEvents("123e4567-e89b-42d3-a456-426614174000"),
      home,
    });
    expect(selected).toMatchObject({ outcome: "known", turns: [{ executedProfile: { model: "kimi-coding/older", reasoningLevel: "high" } }] });
  });

  it("GUARD: preserves completed Codex correlation and conflict handling", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const providerThreadId = "018cc251-f400-7000-8000-000000000000";
    jsonl(join(home, ".codex", "sessions", "2024", "01", "01", `rollout-${providerThreadId}.jsonl`), [
      { type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-5.6-sol", effort: "medium" } },
      { type: "turn_context", payload: { turn_id: "turn-2", model: "gpt-5.6-sol", effort: "medium" } },
      { type: "turn_context", payload: { turn_id: "turn-2", model: "gpt-5.6-luna", effort: "medium" } },
    ]);
    jsonl(join(home, ".codex", "sessions", "2023", "12", "31", `rollout-${providerThreadId}.jsonl`), [{ not: "the target session" }]);
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

  it("correlates Pi completion ids to assistant messages and their reasoning state", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const directory = join(home, ".pi", "agent", "sessions", "--test-project--");
    jsonl(join(directory, "2026-08-20T00-00-00-000Z_123e4567-e89b-42d3-a456-426614174000.jsonl"), [
      { type: "session", version: 3, id: "123e4567-e89b-42d3-a456-426614174000", timestamp: "2026-08-20T00:00:00.000Z", cwd: "/test/project" },
      { type: "model_change", id: "00000001", parentId: null, timestamp: "2026-08-20T00:00:01.000Z", provider: "kimi-coding", modelId: "k3" },
      { type: "thinking_level_change", id: "00000002", parentId: "00000001", timestamp: "2026-08-20T00:00:02.000Z", thinkingLevel: "high" },
      { type: "message", id: "00000003", parentId: "00000002", timestamp: "2026-08-20T00:00:03.000Z", message: { role: "assistant", provider: "kimi-coding", model: "k3", usage: { reasoning: 42 }, content: "DO_NOT_EMIT" } },
    ]);
    const result = await readExecutedProfiles({
      thread: { providerId: "pi" },
      environment: { path: "/test/project" },
      events: [completion("pi-session", "00000003")],
      home,
    });
    expect(result).toMatchObject({
      outcome: "known",
      coverage: { completedTurns: 1, knownTurns: 1, unknownTurns: 0 },
      turns: [{
        status: "known",
        executedProfile: { providerId: "pi", model: "kimi-coding/k3", reasoningLevel: "high", kind: "executed-provider-native" },
      }],
    });
    expect(JSON.stringify(result)).not.toContain("DO_NOT_EMIT");
  });

  it("returns a named unknown when Pi checkpoint ids do not correlate", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    jsonl(join(home, ".pi", "agent", "sessions", "--test-project--", "2026-08-20T00-00-00-000Z_123e4567-e89b-42d3-a456-426614174000.jsonl"), [
      { type: "session", version: 3, id: "123e4567-e89b-42d3-a456-426614174000", timestamp: "2026-08-20T00:00:00.000Z", cwd: "/test/project" },
      { type: "message", id: "00000003", parentId: "checkpoint-1", message: { role: "assistant", provider: "kimi-coding", model: "k3", usage: { reasoning: 42 }, content: "DO_NOT_EMIT" } },
    ]);
    const result = await readExecutedProfiles({
      thread: { providerId: "pi" },
      environment: { path: "/test/project" },
      events: [completion("pi-session", "checkpoint-1")],
      home,
    });
    expect(result).toMatchObject({
      outcome: "unknown",
      reason: "Pi checkpoints do not correlate to assistant message ids carrying model and reasoning level",
      turns: [{ reason: "Pi checkpoints do not correlate to assistant message ids carrying model and reasoning level" }],
    });
    expect(JSON.stringify(result)).not.toMatch(/DO_NOT_EMIT|content/u);
  });

  it("refuses a Pi session whose header names a different cwd", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-collab-profile-"));
    const path = join(home, ".pi", "agent", "sessions", "--test-project--", "2026-08-20T00-00-00-000Z_123e4567-e89b-42d3-a456-426614174000.jsonl");
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

    const piRoot = join(home, ".pi", "agent", "sessions");
    mkdirSync(piRoot, { recursive: true });
    symlinkSync(outsideDirectory, join(piRoot, "--pi-dir--"), "dir");
    const piDirectoryResult = await readExecutedProfiles({
      thread: { providerId: "pi" },
      environment: { path: "/pi/dir" },
      events: [completion("pi-session", "turn-1")],
      home,
    });
    expect(piDirectoryResult).toMatchObject({ outcome: "unknown", reason: "expected at least one Pi session log in the exact environment-derived project directory, found 0" });
    expect(JSON.stringify(piDirectoryResult)).not.toMatch(/DO_NOT_EMIT|private-other-project|executedProfile/u);

    const piDirectory = join(piRoot, "--pi-file--");
    mkdirSync(piDirectory, { recursive: true });
    symlinkSync(outsideFile, join(piDirectory, "2026-08-20T00-00-00-000Z_123e4567-e89b-42d3-a456-426614174000.jsonl"));
    const piFileResult = await readExecutedProfiles({
      thread: { providerId: "pi" },
      environment: { path: "/pi/file" },
      events: [completion("pi-session", "turn-1")],
      home,
    });
    expect(piFileResult).toMatchObject({ outcome: "unknown", reason: "expected at least one Pi session log in the exact environment-derived project directory, found 0" });
    expect(JSON.stringify(piFileResult)).not.toMatch(/DO_NOT_EMIT|private-codex-log|executedProfile/u);
  });
});
