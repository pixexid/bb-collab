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

function jsonl(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

describe("executed profile read-back", () => {
  it("correlates Codex turn_context and rejects conflicting profiles", async () => {
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

  it("returns unknown for an unmeasured provider instead of using requested values", async () => {
    const result = await readExecutedProfiles({
      thread: { providerId: "pi" },
      events: [completion("pi-session", "turn-1"), completion("pi-session", null)],
      home: mkdtempSync(join(tmpdir(), "bb-collab-profile-")),
    });
    expect(result).toMatchObject({
      outcome: "unknown",
      reason: "provider pi has no measured native read-back",
      turns: [
        { reason: "provider pi has no measured native read-back" },
        { reason: "provider pi has no measured native read-back" },
      ],
    });
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
  });
});
