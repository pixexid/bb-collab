import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import companionWatcher, { hasActiveWorkers, parseCanonicalExport, parseJudgment, readRoleThread, routeJudgment } from "../server.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const affirmative = parseJudgment("COVERAGE: known\nFINDING: promised follow-up was not done\nESCALATE: yes");

async function capturedExport() {
  return parseCanonicalExport(await readFile(join(fixtureRoot, "live-export.json"), "utf8"), fixtureRoot);
}

describe("semantic idle guard", () => {
  it("parses only anchored judgments and degrades malformed coverage to blind", () => {
    expect(affirmative).toMatchObject({ illegitimate: true, coverage: "known" });
    expect(parseJudgment("prefix COVERAGE: known\nFINDING: parked\nESCALATE: yes")).toMatchObject({ illegitimate: true, coverage: "blind" });
    expect(parseJudgment("COVERAGE: partial\nFINDING: parked")).toMatchObject({ illegitimate: false, coverage: "partial" });
    expect(parseJudgment("COVERAGE: known\nESCALATE: yes")).toMatchObject({ illegitimate: false });
  });

  it("parses the captured canonical export shape", async () => {
    const canonical = await capturedExport();
    expect(readRoleThread(canonical, "proj_a8zzfsx36j", "project-orchestrator")).toBe("thr_7bjw9e7mgd");
    expect(hasActiveWorkers(canonical, "proj_a8zzfsx36j")).toBe(true);
    expect(hasActiveWorkers({ ...canonical, executionAttempts: canonical.executionAttempts.filter((row) => row.state !== "running") }, "proj_a8zzfsx36j")).toBe(false);
  });

  it("degrades the snapshot to blind when the export CLI fails", async () => {
    let tool: { execute(params: unknown, context: { threadId: string; projectId: string }): Promise<unknown> } | undefined;
    const bb = {
      pluginId: "companion-watcher",
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
