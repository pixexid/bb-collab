import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import companionWatcher, { composeTimeline, hasActiveWorkers, parseCanonicalExport, parseJudgment, readRoleThread, routeJudgment, snapshotCanonical } from "../server.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const projectId = "proj_a8zzfsx36j";
const affirmative = parseJudgment("COVERAGE: known\nFINDING: promised follow-up was not done\nESCALATE: yes");

async function capturedExport() {
  return parseCanonicalExport(await readFile(join(fixtureRoot, "live-export.json"), "utf8"), fixtureRoot, projectId);
}

const inlineExport = (recordsNdjson: string, tableCounts: Record<string, number>) => JSON.stringify({
  outcome: "OK",
  export: { recordsNdjson, manifest: { projectId, tableCounts } },
});

describe("semantic idle guard", () => {
  it("parses only anchored judgments and degrades malformed coverage to blind", () => {
    expect(affirmative).toMatchObject({ illegitimate: true, coverage: "known" });
    expect(parseJudgment("prefix COVERAGE: known\nFINDING: parked\nESCALATE: yes")).toMatchObject({ illegitimate: true, coverage: "blind" });
    expect(parseJudgment("COVERAGE: partial\nFINDING: parked")).toMatchObject({ illegitimate: false, coverage: "partial" });
    expect(parseJudgment("COVERAGE: known\nESCALATE: yes")).toMatchObject({ illegitimate: false });
  });

  it("parses the captured canonical export shape", async () => {
    const canonical = await capturedExport();
    expect(readRoleThread(canonical, projectId, "project-orchestrator")).toBe("thr_7bjw9e7mgd");
    expect(canonical.parseIssues).toEqual([]);
    expect(hasActiveWorkers(canonical, projectId)).toBe(true);
    expect(hasActiveWorkers({ ...canonical, executionAttempts: canonical.executionAttempts.filter((row) => row.state !== "running") }, projectId)).toBe(false);
  });

  it("accepts nullable execution-attempt fields, including the captured review boundary", async () => {
    const records = (await readFile(join(fixtureRoot, "live-export", "records.ndjson"), "utf8")).split("\n").filter(Boolean).map((line) => {
      const record = JSON.parse(line) as { table: string; row: Record<string, unknown> };
      if (record.table === "execution_attempts" && record.row.origin === "work_item") {
        record.row.execution_attempt_id = "fd94c2f39e7bc72ecc454bb3cf5b5d6b95d7a5b44dcf7942bd846e3c3565dd2c";
        record.row.state = "superseded";
        record.row.thread_id = null;
        record.row.work_item_id = "wi-gh-559";
      }
      return JSON.stringify(record);
    }).join("\n");
    const canonical = await parseCanonicalExport(inlineExport(records, { execution_attempts: 2, role_generation_heads: 1, role_generations: 1, work_items: 1 }), fixtureRoot, projectId);
    expect(canonical.parseIssues).toEqual([]);
    expect(canonical.executionAttempts.find((row) => row.execution_attempt_id === "fd94c2f39e7bc72ecc454bb3cf5b5d6b95d7a5b44dcf7942bd846e3c3565dd2c")).toMatchObject({ thread_id: null, work_item_id: "wi-gh-559", state: "superseded" });
  });

  it("keeps a canonical population over 100 rows bounded and fully known below the ceiling", async () => {
    const canonical = await capturedExport();
    const expanded = {
      ...canonical,
      executionAttempts: Array.from({ length: 150 }, (_, index) => ({ ...canonical.executionAttempts[0], execution_attempt_id: `attempt-${index}` })),
      workItems: Array.from({ length: 125 }, (_, index) => ({ ...canonical.workItems[0], work_item_id: `work-item-${index}` })),
    };
    const snapshot = snapshotCanonical(expanded, 0);
    expect(snapshot).toMatchObject({ coverage: "known" });
    expect(snapshot.executionAttempts).toHaveLength(150);
    expect(snapshot.workItems).toHaveLength(125);
  });

  it("keeps the native timeline page bounded and reports older rows as partial", async () => {
    let tool: { execute(params: unknown, context: { threadId: string; projectId: string }): Promise<unknown> } | undefined;
    let hasOlderRows = true;
    let timelineCalls = 0;
    let timelineArgs: { segmentLimit?: string } | undefined;
    const bb = {
      pluginId: "companion-watcher",
      log: { warn: () => undefined },
      storage: { kv: { get: async () => undefined, set: async () => undefined } },
      agents: { registerTool: (value: typeof tool) => { tool = value; }, configure: () => undefined },
      sdk: {
        system: { config: async () => ({ dataDir: "/unused" }) },
        projects: { get: async () => ({ gitRemoteUrl: null }) },
        threads: {
          get: async () => ({ projectId, title: "Alzheimer companion judgment", originPluginId: "companion-watcher" }),
          timeline: async (args: typeof timelineArgs) => { timelineArgs = args; timelineCalls += 1; return { rows: [], timelinePage: { hasOlderRows, kind: "latest", segmentLimit: Number(args?.segmentLimit), returnedSegmentCount: 0, olderCursor: hasOlderRows ? { anchorSeq: timelineCalls, anchorId: `anchor-${timelineCalls}` } : null }, maxSeq: 0 }; },
          queuedMessages: { list: async () => [] },
        },
      },
      events: { on: () => undefined },
    } as unknown as BbPluginApi;
    companionWatcher(bb, capturedExport, async () => []);
    const run = async () => JSON.parse(await tool!.execute({}, { threadId: "companion", projectId }) as string) as { coverage: string };
    expect((await run()).coverage).toBe("partial");
    expect(timelineArgs?.segmentLimit).toBe("100");
    expect(timelineCalls).toBe(10);
    hasOlderRows = false;
    expect((await run()).coverage).toBe("known");
  });

  it("follows native timeline cursors to recover the bounded current history", async () => {
    let tool: { execute(params: unknown, context: { threadId: string; projectId: string }): Promise<unknown> } | undefined;
    const calls: Array<Record<string, string>> = [];
    const bb = {
      pluginId: "companion-watcher",
      log: { warn: () => undefined },
      storage: { kv: { get: async () => undefined, set: async () => undefined } },
      agents: { registerTool: (value: typeof tool) => { tool = value; }, configure: () => undefined },
      sdk: {
        system: { config: async () => ({ dataDir: "/unused" }) },
        projects: { get: async () => ({ gitRemoteUrl: null }) },
        threads: {
          get: async () => ({ projectId, title: "Alzheimer companion judgment", originPluginId: "companion-watcher" }),
          timeline: async (args: Record<string, string>) => {
            calls.push(args);
            return calls.length === 1
              ? { rows: [{ id: "new" }], timelinePage: { hasOlderRows: true, kind: "latest", segmentLimit: 100, returnedSegmentCount: 1, olderCursor: { anchorSeq: 9, anchorId: "old-anchor" } }, maxSeq: 10 }
              : { rows: [{ id: "old" }], timelinePage: { hasOlderRows: false, kind: "older", segmentLimit: 100, returnedSegmentCount: 1, olderCursor: null }, maxSeq: 10 };
          },
          queuedMessages: { list: async () => [] },
        },
      },
      events: { on: () => undefined },
    } as unknown as BbPluginApi;
    companionWatcher(bb, capturedExport, async () => []);
    const result = JSON.parse(await tool!.execute({}, { threadId: "companion", projectId }) as string) as { coverage: string; recentTimeline: { rows: Array<{ id: string }> } };
    expect(result.coverage).toBe("known");
    expect(result.recentTimeline.rows.map((row) => row.id)).toEqual(["old", "new"]);
    expect(calls).toEqual([
      { threadId: "thr_7bjw9e7mgd", segmentLimit: "100" },
      { threadId: "thr_7bjw9e7mgd", segmentLimit: "100", beforeAnchorSeq: "9", beforeAnchorId: "old-anchor" },
    ]);
  });

  it("composes paged timelines in native order with latest metadata and envelope", () => {
    const latest = {
      rows: [{ id: "boundary", text: "new boundary" }, { id: "newest", text: "newest" }],
      activePromptMode: { mode: "plan", providerId: "codex", prompt: "latest" },
      activeThinking: { id: "thinking", text: "latest", startedAt: 3, updatedAt: 4 },
      activeWorkflows: [{ id: "workflow-latest" }],
      activeBackgroundCommands: [{ id: "command-latest" }],
      contextWindowUsage: { usedTokens: 9, modelContextWindow: 10, estimated: false },
      pendingTodos: { sourceSeq: 8, updatedAt: 8, items: [] },
      modelFallback: { sourceSeq: 8, detectedAt: 8, originalModel: "old", fallbackModel: "latest", reason: "provider", message: "latest" },
      timelinePage: { kind: "latest", segmentLimit: 100, returnedSegmentCount: 2, hasOlderRows: true, olderCursor: { anchorSeq: 2, anchorId: "anchor" } },
      maxSeq: 100,
    } as unknown as Parameters<typeof composeTimeline>[0];
    const older = {
      rows: [{ id: "oldest", text: "oldest" }, { id: "boundary", text: "old boundary" }],
      activePromptMode: null,
      activeThinking: null,
      activeWorkflows: [],
      activeBackgroundCommands: [],
      contextWindowUsage: { usedTokens: 1, modelContextWindow: 2, estimated: true },
      pendingTodos: null,
      modelFallback: null,
      timelinePage: { kind: "older", segmentLimit: 100, returnedSegmentCount: 2, hasOlderRows: false, olderCursor: null },
      maxSeq: 2,
    } as unknown as Parameters<typeof composeTimeline>[0];
    const oldest = {
      ...older,
      rows: [{ id: "very-old", text: "very old" }],
      timelinePage: { ...older.timelinePage, hasOlderRows: false, olderCursor: null },
    } as unknown as Parameters<typeof composeTimeline>[0];
    const composed = composeTimeline(latest, [older, oldest]);
    expect(composed.rows.map((row) => row.id)).toEqual(["very-old", "oldest", "boundary", "newest"]);
    expect(composed.rows.find((row) => row.id === "boundary")).toMatchObject({ text: "new boundary" });
    expect(composed).toMatchObject({ activePromptMode: latest.activePromptMode, activeThinking: latest.activeThinking, activeWorkflows: latest.activeWorkflows, activeBackgroundCommands: latest.activeBackgroundCommands, contextWindowUsage: latest.contextWindowUsage, pendingTodos: latest.pendingTodos, modelFallback: latest.modelFallback, maxSeq: 100, timelinePage: { hasOlderRows: false, returnedSegmentCount: 4 } });
  });

  it("rejects a non-OK canonical export outcome", async () => {
    await expect(parseCanonicalExport('{"outcome":"CANONICAL_STORE_UNAVAILABLE"}', fixtureRoot, projectId)).rejects.toThrow("canonical-export-CANONICAL_STORE_UNAVAILABLE");
  });

  it("rejects a missing canonical export payload", async () => {
    await expect(parseCanonicalExport('{"outcome":"OK"}', fixtureRoot, projectId)).rejects.toThrow("canonical-export-records-missing");
  });

  it("rejects an unreadable canonical export payload", async () => {
    const output = JSON.stringify({ outcome: "OK", evidence: { exportFile: { complete: true, directory: "missing-export", manifest: { projectId, tableCounts: {} } } } });
    await expect(parseCanonicalExport(output, fixtureRoot, projectId)).rejects.toThrow(/ENOENT/u);
  });

  it("rejects a canonical export without the orchestrator head", async () => {
    const records = (await readFile(join(fixtureRoot, "live-export", "records.ndjson"), "utf8")).split("\n").filter((line) => !line.includes('"table":"role_generation_heads"')).join("\n");
    await expect(parseCanonicalExport(inlineExport(records, { execution_attempts: 2, role_generation_heads: 0, role_generations: 1, work_items: 1 }), fixtureRoot, projectId)).rejects.toThrow("canonical-export-orchestrator-head-missing");
  });

  it("rejects unparseable canonical export records", async () => {
    await expect(parseCanonicalExport(inlineExport('{"table":', { execution_attempts: 0, role_generation_heads: 0, role_generations: 0, work_items: 0 }), fixtureRoot, projectId)).rejects.toThrow(SyntaxError);
  });

  it("rejects a partial export missing declared work items", async () => {
    const records = (await readFile(join(fixtureRoot, "live-export", "records.ndjson"), "utf8")).split("\n").filter((line) => !line.includes('"table":"work_items"')).join("\n");
    await expect(parseCanonicalExport(inlineExport(records, { execution_attempts: 2, role_generation_heads: 1, role_generations: 1, work_items: 1 }), fixtureRoot, projectId)).rejects.toThrow("canonical-export-work_items-count-mismatch");
  });

  it("skips a malformed non-holder attempt and marks the snapshot partial", async () => {
    const records = (await readFile(join(fixtureRoot, "live-export", "records.ndjson"), "utf8")).split("\n").filter(Boolean).map((line) => {
      const record = JSON.parse(line) as { table: string; row: Record<string, unknown> };
      if (record.table === "execution_attempts" && record.row.origin === "work_item") delete record.row.state;
      return JSON.stringify(record);
    }).join("\n");
    const canonical = await parseCanonicalExport(inlineExport(records, { execution_attempts: 2, role_generation_heads: 1, role_generations: 1, work_items: 1 }), fixtureRoot, projectId);
    expect(canonical.executionAttempts).toHaveLength(1);
    expect(canonical.parseIssues).toEqual(["execution_attempts.state"]);
    expect(snapshotCanonical(canonical, 0)).toMatchObject({ coverage: "partial", parseIssues: ["execution_attempts.state"] });
  });

  it("fails closed when a malformed attempt is the current orchestrator holder", async () => {
    const records = (await readFile(join(fixtureRoot, "live-export", "records.ndjson"), "utf8")).split("\n").filter(Boolean).map((line) => {
      const record = JSON.parse(line) as { table: string; row: Record<string, unknown> };
      if (record.table === "execution_attempts" && record.row.origin === "role_holder") delete record.row.state;
      return JSON.stringify(record);
    }).join("\n");
    await expect(parseCanonicalExport(inlineExport(records, { execution_attempts: 2, role_generation_heads: 1, role_generations: 1, work_items: 1 }), fixtureRoot, projectId)).rejects.toThrow("canonical-export-orchestrator-thread-unresolved");
  });

  it("degrades the snapshot to blind and logs the reason when the export CLI fails", async () => {
    let tool: { execute(params: unknown, context: { threadId: string; projectId: string }): Promise<unknown> } | undefined;
    const warnings: string[] = [];
    const bb = {
      pluginId: "companion-watcher",
      log: { warn: (message: string) => warnings.push(message) },
      storage: { kv: { get: async () => undefined, set: async () => undefined } },
      agents: { registerTool: (value: typeof tool) => { tool = value; }, configure: () => undefined },
      sdk: {
        system: { config: async () => ({ dataDir: "/unused" }) },
        threads: { get: async () => ({ projectId: "p", title: "Alzheimer companion judgment", originPluginId: "companion-watcher" }) },
      },
      events: { on: () => undefined },
    } as unknown as BbPluginApi;
    companionWatcher(bb, async () => { throw new Error("export CLI failed"); });
    const result = await tool!.execute({}, { threadId: "companion", projectId: "p" });
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("COVERAGE: blind") }] });
    expect(result).toMatchObject({ content: [{ text: expect.stringContaining("export CLI failed") }] });
    expect(warnings).toEqual(["companion-watcher coverage=blind event=snapshot reason=Error: export CLI failed"]);
  });

  it("logs the parser degradation reason", async () => {
    let tool: { execute(params: unknown, context: { threadId: string; projectId: string }): Promise<unknown> } | undefined;
    const warnings: string[] = [];
    const bb = {
      pluginId: "companion-watcher",
      log: { warn: (message: string) => warnings.push(message) },
      storage: { kv: { get: async () => undefined, set: async () => undefined } },
      agents: { registerTool: (value: typeof tool) => { tool = value; }, configure: () => undefined },
      sdk: {
        system: { config: async () => ({ dataDir: "/unused" }) },
        threads: { get: async () => ({ projectId, title: "Alzheimer companion judgment", originPluginId: "companion-watcher" }) },
      },
      events: { on: () => undefined },
    } as unknown as BbPluginApi;
    companionWatcher(bb, async () => parseCanonicalExport(inlineExport("", { execution_attempts: 0, role_generation_heads: 0, role_generations: 0, work_items: 0 }), fixtureRoot, projectId));
    await tool!.execute({}, { threadId: "companion", projectId });
    expect(warnings).toEqual(["companion-watcher coverage=blind event=snapshot reason=Error: canonical-export-orchestrator-head-missing"]);
  });

  it("backs off unchanged findings, then routes a post-turn repeat to the director", () => {
    const prior = { sentAt: 100, fingerprint: affirmative.fingerprint };
    expect(routeJudgment(prior, affirmative, 200, undefined)).toBeUndefined();
    expect(routeJudgment(prior, affirmative, 600_100, undefined)).toBe("orchestrator");
    expect(routeJudgment(prior, affirmative, 200, 101)).toBe("director");
  });

  it("holds repeated director escalations for 24 hours", () => {
    const prior = { sentAt: 100, fingerprint: affirmative.fingerprint, escalatedAt: 150 };
    expect(routeJudgment(prior, affirmative, 23 * 60 * 60_000, 200)).toBeUndefined();
    expect(routeJudgment(prior, affirmative, 25 * 60 * 60_000, 200)).toBe("director");
  });
});
