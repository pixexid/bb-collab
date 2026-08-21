import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { BbPluginApi } from "@bb/plugin-sdk";

const exec = promisify(execFile);
const MODEL = "gpt-5.6-luna";
const PROVIDER = "codex";
const REASONING = "medium";
const DEFAULT_CADENCE_MINUTES = 60;
const DEFAULT_JITTER_MINUTES = 5;
const MAX_RECENT_EVENTS = 40;
const MAX_PAGE = 100;
const ESCALATION_HOLD_MS = 24 * 60 * 60_000;
const DECLARATION_LEAD_MS = 60_000;

type Coverage = "known" | "partial" | "blind";

const accepted = z.object({ accepted: z.literal(true) }).strict();
export function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function intervalId(projectId: string, observedAtMs: number, cadenceMinutes: number): string {
  const slot = Math.floor(observedAtMs / (cadenceMinutes * 60000));
  return `alzheimer:${projectId}:${slot}`;
}
export function nextWake(now: number, cadenceMinutes: number, jitterMinutes: number, random = Math.random()): number {
  return now + cadenceMinutes * 60_000 + Math.floor(random * (jitterMinutes * 2 + 1) - jitterMinutes) * 60_000;
}
export function parseJudgment(output: string): { coverage: Coverage; escalate: boolean; report: string } {
  const match = output.match(/(?:^|\n)COVERAGE:\s*(known|partial|blind)\s*\n?/iu);
  const coverage = (match?.[1]?.toLowerCase() ?? "blind") as Coverage;
  return { coverage, escalate: /(?:^|\n)ESCALATE:\s*yes\b/iu.test(output), report: output.slice(0, 32_000) };
}

function openCanonical(path: string): Database.Database { return new Database(path, { readonly: true, fileMustExist: true }); }
function rows(db: Database.Database, sql: string, projectId: string): unknown[] { return db.prepare(sql).all(projectId) as unknown[]; }
// These two evidence reads deliberately replace the old pure-code predicates in
// plugins/bb-plugin-companion-watcher/server.ts; they are inputs to judgment, never gates.
async function githubEvidence(remote: string | null): Promise<unknown> {
  const repo = remote?.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/u)?.[1];
  if (!repo) throw new Error("github-repository-unresolved");
  const { stdout } = await exec("gh", ["pr", "list", "--repo", repo, "--state", "open", "--json", "number,state,mergeStateStatus,reviewDecision,headRefOid,reviews,statusCheckRollup", "--limit", String(MAX_PAGE)], { timeout: 10_000 });
  return JSON.parse(stdout);
}

export default function alzheimer(bb: BbPluginApi) {
  const settings = bb.settings.define({
    project: { type: "project", label: "Project to observe" },
    cadenceMinutes: { type: "string", label: "Judgment cadence (minutes)", default: String(DEFAULT_CADENCE_MINUTES) },
    jitterMinutes: { type: "string", label: "Wake jitter (minutes)", default: String(DEFAULT_JITTER_MINUTES) },
  });
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    "CREATE TABLE IF NOT EXISTS receipts (interval_id TEXT PRIMARY KEY, observed_at_ms INTEGER NOT NULL, thread_id TEXT NOT NULL, coverage TEXT NOT NULL CHECK (coverage IN ('known','partial','blind')), report_digest TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, observed_at_ms INTEGER NOT NULL, summary TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS holds (project_id TEXT PRIMARY KEY, finding_digest TEXT NOT NULL, held_at_ms INTEGER NOT NULL)",
    "DROP TABLE IF EXISTS receipts",
  ]);
  let companionThreadId: string | undefined;
  let pendingInterval: string | undefined;
  let nextDue = 0;

  bb.agents.registerTool({
    name: "alzheimer_read_canonical",
    description: "Read the bounded canonical companion snapshot. This is the only companion read capability.",
    parameters: z.object({ projectId: z.string().min(1) }).strict(),
    execute: async ({ projectId }, context) => {
      if (projectId !== context.projectId) return { isError: true, content: [{ type: "text", text: "project mismatch" }] };
      let canonical: Database.Database | undefined;
      try {
        const config = await bb.sdk.system.config();
        canonical = openCanonical(`${config.dataDir}/plugins/bb-collab/data.db`);
        const project = await bb.sdk.projects.get({ projectId });
        const orchestrator = await bb.sdk.threads.get({ threadId: context.threadId });
        const recent = await bb.sdk.threads.events.list({ threadId: context.threadId, limit: String(MAX_RECENT_EVENTS) });
        const queued = await bb.sdk.threads.queuedMessages.list({ threadId: context.threadId });
        const attempts = rows(canonical, "SELECT execution_attempt_id, thread_id, assignment_kind, state, lane_id, work_item_id FROM execution_attempts WHERE project_id=? ORDER BY observed_at_ms DESC LIMIT 100", projectId);
        const roles = rows(canonical, "SELECT role_id, current_generation, updated_at_ms FROM role_generation_heads WHERE project_id=? ORDER BY role_id LIMIT 100", projectId);
        const work = rows(canonical, "SELECT work_item_id, title, lifecycle_state FROM work_items WHERE project_id=? ORDER BY work_item_id LIMIT 100", projectId);
        const observations = db.prepare("SELECT observed_at_ms, summary FROM observations WHERE project_id=? ORDER BY id DESC LIMIT 20").all(projectId) as unknown[];
        let github: unknown;
        let githubCoverage: Coverage = "known";
        try { github = await githubEvidence(project.gitRemoteUrl); } catch (error) { githubCoverage = "blind"; github = { error: String(error) }; }
        const partial = recent.length >= MAX_RECENT_EVENTS || queued.length >= MAX_PAGE || attempts.length >= MAX_PAGE || roles.length >= MAX_PAGE || work.length >= MAX_PAGE;
        const coverage: Coverage = githubCoverage === "blind" ? "blind" : partial ? "partial" : "known";
        return JSON.stringify({ coverage, project: { id: projectId, remote: project.gitRemoteUrl }, orchestrator, recentEvents: recent.slice(-MAX_RECENT_EVENTS), queued: queued.slice(0, MAX_PAGE), executionAttempts: attempts, roles, workItems: work, priorObservations: observations, github }, null, 2);
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: `COVERAGE: blind\ncanonical read failed: ${String(error)}` }] };
      } finally { canonical?.close(); }
    },
  });
  bb.agents.configure(() => ({ tools: ["alzheimer_read_canonical"], skills: [] }));

  const sendJudgment = async (projectId: string, intervalId: string) => {
    if (!companionThreadId) {
      const thread = await bb.sdk.threads.spawn({ projectId, environment: { type: "project-default" }, title: "Alzheimer companion", visibility: "hidden", providerId: PROVIDER, model: MODEL, reasoningLevel: REASONING, permissionMode: "auto", executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", permissionMode: "explicit" }, prompt: `You are the Alzheimer resident companion. This is judgment, not a mechanical detector. Read the current canonical snapshot with alzheimer_read_canonical, compare the orchestrator's stated intentions with what actually happened, and decide whether apparent idleness is illegitimate, including parked-without-cause. Evidence is not a gate on worth. Do not send messages, mutate state, merge, label, or decide worth mechanically. Report a concise judgment and exactly one line COVERAGE: known|partial|blind. If director escalation is warranted, add ESCALATE: yes; otherwise ESCALATE: no. The due interval is ${intervalId}.` });
      companionThreadId = thread.id;
    }
    pendingInterval = intervalId;
    await bb.sdk.threads.send({ threadId: companionThreadId, mode: "auto", input: [{ type: "text", text: `Judgment interval ${intervalId} is due. Read current state now; this wake is not conditional on any mechanical finding. Return the bounded judgment format.`, mentions: [] }] });
  };

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    if (!pendingInterval || thread.id !== companionThreadId) return;
    const parsed = parseJudgment(lastAssistantText ?? "");
    const receipt = { projectId: thread.projectId, intervalId: pendingInterval, observedAtMs: Date.now(), threadId: thread.id, coverage: parsed.coverage, reportDigest: digest(parsed.report) };
    const observation = db.prepare("INSERT INTO observations (project_id, observed_at_ms, summary) VALUES (?, ?, ?)").run(thread.projectId, receipt.observedAtMs, parsed.report.slice(-32_000));
    db.prepare("DELETE FROM observations WHERE project_id=? AND id NOT IN (SELECT id FROM observations WHERE project_id=? ORDER BY id DESC LIMIT 100)").run(thread.projectId, thread.projectId);
    try {
      await bb.sdk.plugins.callRpc({ pluginId: "companion-liveness-checker", method: "recordReceipt", input: receipt, outputSchema: accepted });
    } catch (error) {
      bb.log.warn(`alzheimer coverage=blind interval=${receipt.intervalId} reason=receipt-rejected:${String(error)}`);
    }
    pendingInterval = undefined;
    if (Number(observation.lastInsertRowid) % 20 === 0) {
      try { await bb.sdk.threads.compact({ threadId: thread.id }); } catch (error) { bb.log.warn(`alzheimer context-rotation-failed: ${String(error)}`); }
    }
    if (parsed.escalate) {
      const prior = db.prepare("SELECT held_at_ms FROM holds WHERE project_id=?").get(thread.projectId) as { held_at_ms: number } | undefined;
      if (!prior || Date.now() - prior.held_at_ms >= ESCALATION_HOLD_MS) {
        const config = await bb.sdk.system.config();
        const canonical = openCanonical(`${config.dataDir}/plugins/bb-collab/data.db`);
        try {
          const director = canonical.prepare("SELECT a.thread_id AS thread_id FROM role_generation_heads h JOIN role_generations g ON g.project_id=h.project_id AND g.role_id=h.role_id AND g.generation=h.current_generation JOIN execution_attempts a ON a.project_id=g.project_id AND a.execution_attempt_id=g.holder_execution_attempt_id WHERE h.project_id=? AND h.role_id='director'").get(thread.projectId) as { thread_id: string } | undefined;
          if (director) await bb.sdk.threads.send({ threadId: director.thread_id, mode: "auto", input: [{ type: "text", text: `Alzheimer companion escalation: ${parsed.report.slice(-8_000)}\nReceipt: ${receipt.reportDigest}`, mentions: [] }] });
          db.prepare("INSERT OR REPLACE INTO holds VALUES (?, ?, ?)").run(thread.projectId, receipt.reportDigest, Date.now());
        } finally { canonical.close(); }
      }
    }
  });

  bb.background.schedule("judgment-wake", "* * * * *", async () => {
    const { project, cadenceMinutes, jitterMinutes } = await settings.get();
    if (!project) return;
    const now = Date.now();
    if (now < nextDue) return;
    const config = await bb.sdk.system.config();
    const canonical = openCanonical(`${config.dataDir}/plugins/bb-collab/data.db`);
    try {
      const active = canonical.prepare("SELECT COUNT(*) AS count FROM execution_attempts WHERE project_id=? AND origin='work_item' AND state NOT IN ('succeeded','failed','cancelled')").get(project) as { count: number };
      if (Number(active.count) > 0) { nextDue = nextWake(now, Number(cadenceMinutes), Number(jitterMinutes)); return; }
    } finally { canonical.close(); }
    const interval = intervalId(project, now, Number(cadenceMinutes));
    nextDue = nextWake(now, Number(cadenceMinutes), Number(jitterMinutes));
    try {
      await bb.sdk.plugins.callRpc({ pluginId: "companion-liveness-checker", method: "recordExpected", input: { projectId: project, intervalId: interval, dueAtMs: now + DECLARATION_LEAD_MS }, outputSchema: accepted });
      await sendJudgment(project, interval);
    } catch (error) { bb.log.warn(`alzheimer coverage=blind interval=${interval} reason=${String(error)}`); }
  });
}
