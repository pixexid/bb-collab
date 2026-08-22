import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import companionWatcher, { hasActiveWorkers, parseCanonicalExport, parseJudgment, readRoleThread, routeJudgment } from "../server.js";

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
    expect(hasActiveWorkers(canonical, projectId)).toBe(true);
    expect(hasActiveWorkers({ ...canonical, executionAttempts: canonical.executionAttempts.filter((row) => row.state !== "running") }, projectId)).toBe(false);
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

  it("degrades a count-consistent export with a missing consumed attempt field to blind", async () => {
    const records = (await readFile(join(fixtureRoot, "live-export", "records.ndjson"), "utf8")).split("\n").filter(Boolean).map((line) => {
      const record = JSON.parse(line) as { table: string; row: Record<string, unknown> };
      if (record.table === "execution_attempts" && record.row.origin === "work_item") delete record.row.state;
      return JSON.stringify(record);
    }).join("\n");
    await expect(parseCanonicalExport(inlineExport(records, { execution_attempts: 2, role_generation_heads: 1, role_generations: 1, work_items: 1 }), fixtureRoot, projectId)).rejects.toThrow("canonical-export-execution_attempts-state-invalid");
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
