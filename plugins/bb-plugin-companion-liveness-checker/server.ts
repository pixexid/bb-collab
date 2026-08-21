import Database from "better-sqlite3";
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

export type Coverage = "known" | "partial" | "blind";
export type Receipt = { intervalId: string; observedAtMs: number; threadId: string; coverage: Coverage; reportDigest: string };
export type Expected = { projectId: string; intervalId: string; dueAtMs: number };
export type Reconciliation = { intervalId: string; status: "missing" | "late" | "blind"; observedAtMs?: number };

export function intervalId(projectId: string, observedAtMs: number, cadenceMinutes: number): string {
  const slot = Math.floor(observedAtMs / (cadenceMinutes * 60000));
  return `alzheimer:${projectId}:${slot}`;
}

export const reconcile = (expected: readonly Expected[], receipts: readonly Receipt[], nowMs: number, lateAfterMs = 5 * 60_000): Reconciliation[] => {
  const byInterval = new Map(receipts.map((receipt) => [receipt.intervalId, receipt]));
  return expected.filter((item) => item.dueAtMs <= nowMs).flatMap((item): Reconciliation[] => {
    const receipt = byInterval.get(item.intervalId);
    if (!receipt) return [{ intervalId: item.intervalId, status: "missing" as const }];
    if (receipt.coverage === "blind") return [{ intervalId: item.intervalId, status: "blind" as const, observedAtMs: receipt.observedAtMs }];
    if (receipt.observedAtMs > item.dueAtMs + lateAfterMs) return [{ intervalId: item.intervalId, status: "late" as const, observedAtMs: receipt.observedAtMs }];
    return [];
  });
};

const accepted = z.object({ accepted: z.literal(true) }).strict();
const expectedInput = z.object({
  projectId: z.string().min(1), intervalId: z.string().min(1), dueAtMs: z.number().int().nonnegative(),
}).strict();
const receiptInput = z.object({
  projectId: z.string().min(1), intervalId: z.string().min(1), observedAtMs: z.number().int().nonnegative(),
  threadId: z.string().min(1), coverage: z.enum(["known", "partial", "blind"]), reportDigest: z.string().min(1),
}).strict();
export const rpcContract = defineRpcContract({
  recordExpected: { input: expectedInput, output: accepted },
  recordReceipt: { input: receiptInput, output: accepted },
});

function directorThread(db: Database.Database, projectId: string): string | undefined {
  return (db.prepare(`SELECT a.thread_id AS thread_id FROM role_generation_heads h
    JOIN role_generations g ON g.project_id=h.project_id AND g.role_id=h.role_id AND g.generation=h.current_generation
    JOIN execution_attempts a ON a.project_id=g.project_id AND a.execution_attempt_id=g.holder_execution_attempt_id
    WHERE h.project_id=? AND h.role_id='director'`).get(projectId) as { thread_id?: string } | undefined)?.thread_id;
}

async function configDataDir(bb: BbPluginApi): Promise<string> {
  const config = await bb.sdk.system.config() as { dataDir?: unknown };
  if (typeof config.dataDir !== "string" || !config.dataDir) throw new Error("checker-blind:config-data-dir-unreadable");
  return config.dataDir;
}

export default function companionLivenessChecker(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS expected_intervals (project_id TEXT NOT NULL, interval_id TEXT NOT NULL, due_at_ms INTEGER NOT NULL, PRIMARY KEY (project_id, interval_id))`,
    `CREATE TABLE IF NOT EXISTS companion_receipts (project_id TEXT NOT NULL, interval_id TEXT NOT NULL, observed_at_ms INTEGER NOT NULL, thread_id TEXT NOT NULL, coverage TEXT NOT NULL CHECK (coverage IN ('known','partial','blind')), report_digest TEXT NOT NULL, PRIMARY KEY (project_id, interval_id))`,
    `CREATE TABLE IF NOT EXISTS reports (project_id TEXT NOT NULL, interval_id TEXT NOT NULL, status TEXT NOT NULL, reported_at_ms INTEGER NOT NULL, PRIMARY KEY (project_id, interval_id, status))`,
  ]);
  bb.rpc.register(rpcContract, {
    async recordExpected(input) {
      const project = await bb.sdk.projects.get({ projectId: input.projectId });
      if (project.id !== input.projectId) throw new Error("expected interval project is not native");
      db.prepare("INSERT OR IGNORE INTO expected_intervals(project_id, interval_id, due_at_ms) VALUES(?,?,?)")
        .run(input.projectId, input.intervalId, input.dueAtMs);
      return { accepted: true as const };
    },
    async recordReceipt(input) {
      const expected = db.prepare("SELECT 1 FROM expected_intervals WHERE project_id=? AND interval_id=?").get(input.projectId, input.intervalId);
      if (!expected) throw new Error("receipt interval is not expected");
      const thread = await bb.sdk.threads.get({ threadId: input.threadId });
      if (thread.id !== input.threadId || thread.projectId !== input.projectId) throw new Error("receipt thread is not native project thread");
      db.prepare(`INSERT INTO companion_receipts(project_id, interval_id, observed_at_ms, thread_id, coverage, report_digest) VALUES(?,?,?,?,?,?)
        ON CONFLICT(project_id, interval_id) DO UPDATE SET observed_at_ms=excluded.observed_at_ms, thread_id=excluded.thread_id, coverage=excluded.coverage, report_digest=excluded.report_digest`)
        .run(input.projectId, input.intervalId, input.observedAtMs, thread.id, input.coverage, input.reportDigest);
      return { accepted: true as const };
    },
  });

  bb.background.schedule("companion-liveness", "0 * * * *", async () => {
    const now = Date.now();
    let dataDir: string;
    try { dataDir = await configDataDir(bb); } catch (error) {
      bb.log.warn(`companion-liveness coverage=blind reason=${String(error)}`);
      return;
    }
    let canonical: Database.Database;
    try { canonical = new Database(`${dataDir}/plugins/bb-collab/data.db`, { readonly: true, fileMustExist: true }); } catch (error) {
      bb.log.warn(`companion-liveness coverage=blind reason=canonical-store-unavailable:${String(error)}`);
      return;
    }
    try {
      const projects = db.prepare("SELECT DISTINCT project_id AS projectId FROM expected_intervals WHERE due_at_ms<=?").all(now) as { projectId: string }[];
      for (const project of projects) {
        const expected = db.prepare("SELECT project_id AS projectId, interval_id AS intervalId, due_at_ms AS dueAtMs FROM expected_intervals WHERE project_id=? AND due_at_ms<=?").all(project.projectId, now) as Expected[];
        const receipts = db.prepare("SELECT interval_id AS intervalId, observed_at_ms AS observedAtMs, thread_id AS threadId, coverage, report_digest AS reportDigest FROM companion_receipts WHERE project_id=?").all(project.projectId) as Receipt[];
        const findings = reconcile(expected, receipts, now);
        const director = directorThread(canonical, project.projectId);
        if (!director) { bb.log.warn(`companion-liveness coverage=blind project=${project.projectId} reason=director-unavailable`); continue; }
        for (const finding of findings) {
          const fresh = db.prepare("INSERT OR IGNORE INTO reports(project_id, interval_id, status, reported_at_ms) VALUES(?,?,?,?)").run(project.projectId, finding.intervalId, finding.status, now);
          if (!fresh.changes) continue;
          await bb.sdk.threads.send({ threadId: director, mode: "auto", input: [{ type: "text", text: `Companion liveness ${finding.status}: interval ${finding.intervalId}.`, mentions: [] }] });
        }
      }
    } catch (error) {
      bb.log.warn(`companion-liveness coverage=blind reason=${String(error)}`);
    } finally { canonical.close(); }
  });
}
