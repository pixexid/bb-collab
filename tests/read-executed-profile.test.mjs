import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
});
