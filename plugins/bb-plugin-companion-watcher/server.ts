import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BbPluginApi } from "@bb/plugin-sdk";

const exec = promisify(execFile);
const ACTIVE = ["prepared", "armed", "content_delivered", "running", "dispatch_unknown"];
const BACKOFF_MS = 10 * 60_000;
const ESCALATION_HOLD_MS = 24 * 60 * 60_000;
const SNAPSHOT_LIMIT = 100;
const TOOL = "companion_read_snapshot";
const TITLE = "Alzheimer companion judgment";
type Coverage = "known" | "partial" | "blind";
type Snapshot = { sentAt: number; fingerprint: string; escalatedAt?: number };
type Judgment = { coverage: Coverage; illegitimate: boolean; escalate: boolean; findings: string; fingerprint: string };
type Pending = { projectId: string; orchestratorId: string; turnStartedAt?: number };

export function parseJudgment(output: string): Judgment {
  const coverages = [...output.matchAll(/^COVERAGE:\s*(known|partial|blind)\s*$/gimu)];
  const verdicts = [...output.matchAll(/^ILLEGITIMATE:\s*(yes|no)\s*$/gimu)];
  const escalations = [...output.matchAll(/^ESCALATE:\s*yes\s*$/gimu)];
  const findings = [...output.matchAll(/^FINDING:\s*(.+)\s*$/gimu)].map((match) => match[1]!.trim());
  const coverage = coverages.length === 1 ? coverages[0]![1]!.toLowerCase() as Coverage : "blind";
  const illegitimate = verdicts.length === 1 && verdicts[0]![1]!.toLowerCase() === "yes" && findings.length > 0;
  const text = findings.join("; ").slice(0, 8_000);
  return { coverage, illegitimate, escalate: escalations.length === 1, findings: text, fingerprint: text.toLowerCase() };
}

export function routeJudgment(prior: Snapshot | undefined, judgment: Judgment, now: number, turnStartedAt?: number): "orchestrator" | "director" | undefined {
  if (!judgment.illegitimate) return undefined;
  const unchanged = prior?.fingerprint === judgment.fingerprint;
  if ((judgment.escalate || (unchanged && turnStartedAt !== undefined && turnStartedAt > prior!.sentAt)) && (!unchanged || !prior?.escalatedAt || now - prior.escalatedAt >= ESCALATION_HOLD_MS)) return "director";
  if (unchanged && prior?.escalatedAt && now - prior.escalatedAt < ESCALATION_HOLD_MS) return undefined;
  return !unchanged || !prior || now - prior.sentAt >= BACKOFF_MS ? "orchestrator" : undefined;
}

export function openStore(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true });
}

export function readRoleThread(db: Database.Database, projectId: string, roleId: "project-orchestrator" | "director"): string | undefined {
  return (db.prepare(`SELECT a.thread_id AS thread_id FROM role_generation_heads h JOIN role_generations g ON g.project_id=h.project_id AND g.role_id=h.role_id AND g.generation=h.current_generation JOIN execution_attempts a ON a.project_id=g.project_id AND a.execution_attempt_id=g.holder_execution_attempt_id WHERE h.project_id=? AND h.role_id=?`).get(projectId, roleId) as { thread_id: string } | undefined)?.thread_id;
}

export function hasActiveWorkers(db: Database.Database, projectId: string): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM execution_attempts WHERE project_id=? AND origin='work_item' AND state IN (${ACTIVE.map(() => "?").join(",")})`).get(projectId, ...ACTIVE) as { count: number };
  return Number(row.count) > 0;
}

function rows(db: Database.Database, sql: string, projectId: string): unknown[] {
  return db.prepare(sql).all(projectId, SNAPSHOT_LIMIT) as unknown[];
}

async function githubEvidence(remote: string | null): Promise<unknown> {
  const repo = remote?.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/u)?.[1];
  if (!repo) throw new Error("github-repository-unresolved");
  const { stdout } = await exec("gh", ["pr", "list", "--repo", repo, "--state", "open", "--json", "number,title,state,mergeStateStatus,reviewDecision,headRefOid,statusCheckRollup", "--limit", String(SNAPSHOT_LIMIT)], { timeout: 10_000 });
  return JSON.parse(stdout);
}

const prompt = (projectId: string) => `Judge whether the project orchestrator's current idleness is illegitimate: compare its stated intentions with outcomes and identify undone stated work or work parked without cause. Call ${TOOL} exactly once; do not infer liveness from silence and do not mutate or message anything. Output exactly one anchored line ILLEGITIMATE: yes|no, exactly one anchored line COVERAGE: known|partial|blind, one or more anchored FINDING: lines when yes, and optionally the anchored line ESCALATE: yes when the director should receive this finding. Project: ${projectId}.`;

export default function companionWatcher(bb: BbPluginApi) {
  const snapshots = new Map<string, Snapshot>();
  const companions = new Map<string, string>();
  const pending = new Map<string, Pending>();
  const activeTurns = new Map<string, number>();
  let loaded = false;

  const load = async () => {
    if (loaded) return;
    const saved = await bb.storage.kv.get<Record<string, Snapshot>>("backoff");
    const savedCompanions = await bb.storage.kv.get<Record<string, string>>("companions");
    if (saved) for (const [key, value] of Object.entries(saved)) snapshots.set(key, value);
    if (savedCompanions) for (const [key, value] of Object.entries(savedCompanions)) companions.set(key, value);
    loaded = true;
  };

  bb.agents.registerTool({
    name: TOOL,
    description: "Read one bounded canonical snapshot for semantic idle judgment.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async (_params, context) => {
      await load();
      const caller = await bb.sdk.threads.get({ threadId: context.threadId });
      if (caller.projectId !== context.projectId || caller.title !== TITLE || caller.originPluginId !== bb.pluginId) return { isError: true, content: [{ type: "text", text: "companion-thread-mismatch" }] };
      let db: Database.Database | undefined;
      try {
        const config = await bb.sdk.system.config();
        db = openStore(`${config.dataDir}/plugins/bb-collab/data.db`);
        const orchestratorId = readRoleThread(db, context.projectId, "project-orchestrator");
        if (!orchestratorId) throw new Error("orchestrator-head-unresolved");
        const project = await bb.sdk.projects.get({ projectId: context.projectId });
        const recentTimeline = await bb.sdk.threads.timeline({ threadId: orchestratorId, segmentLimit: String(SNAPSHOT_LIMIT) });
        const queued = await bb.sdk.threads.queuedMessages.list({ threadId: orchestratorId });
        const executionAttempts = rows(db, "SELECT execution_attempt_id, thread_id, assignment_kind, state, lane_id, work_item_id, observed_at_ms FROM execution_attempts WHERE project_id=? ORDER BY observed_at_ms DESC LIMIT ?", context.projectId);
        const workItems = rows(db, "SELECT work_item_id, title, body, lifecycle_state, updated_at_ms FROM work_items WHERE project_id=? ORDER BY updated_at_ms DESC LIMIT ?", context.projectId);
        let github: unknown;
        let coverage: Coverage = queued.length >= SNAPSHOT_LIMIT || executionAttempts.length >= SNAPSHOT_LIMIT || workItems.length >= SNAPSHOT_LIMIT ? "partial" : "known";
        try { github = await githubEvidence(project.gitRemoteUrl); } catch (error) { coverage = "blind"; github = { error: String(error) }; }
        return JSON.stringify({ coverage, orchestratorId, recentTimeline, queued: queued.slice(0, SNAPSHOT_LIMIT), executionAttempts, workItems, github });
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: `COVERAGE: blind\nsnapshot read failed: ${String(error)}` }] };
      } finally { db?.close(); }
    },
  });
  bb.agents.configure((context) => context.origin.pluginId === bb.pluginId && context.thread.title === TITLE ? { tools: [TOOL], skills: [] } : { tools: [], skills: [] });

  const judge = async (projectId: string, orchestratorId: string, turnStartedAt?: number) => {
    await load();
    let threadId = companions.get(projectId);
    if (threadId) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.projectId !== projectId || thread.status !== "idle") return;
      } catch { companions.delete(projectId); threadId = undefined; }
    }
    if (!threadId) {
      const thread = await bb.sdk.threads.spawn({ projectId, environment: { type: "project-default" }, title: TITLE, visibility: "hidden", providerId: "codex", model: "gpt-5.6-luna", reasoningLevel: "medium", permissionMode: "auto", executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", permissionMode: "explicit" }, prompt: prompt(projectId) });
      threadId = thread.id;
      companions.set(projectId, threadId);
      await bb.storage.kv.set("companions", Object.fromEntries(companions));
    } else {
      await bb.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text: prompt(projectId), mentions: [] }] });
    }
    pending.set(threadId, { projectId, orchestratorId, turnStartedAt });
  };

  const handleJudgment = async (threadId: string, output: string) => {
    const request = pending.get(threadId);
    if (!request) return;
    pending.delete(threadId);
    const judgment = parseJudgment(output);
    const prior = snapshots.get(request.projectId);
    const now = Date.now();
    const route = routeJudgment(prior, judgment, now, request.turnStartedAt);
    bb.log.info(`companion-watcher coverage=${judgment.coverage} event=judgment illegitimate=${judgment.illegitimate} route=${route ?? "silence"}`);
    if (!route) return;
    let db: Database.Database | undefined;
    try {
      const config = await bb.sdk.system.config();
      db = openStore(`${config.dataDir}/plugins/bb-collab/data.db`);
      const target = route === "director" ? readRoleThread(db, request.projectId, "director") : readRoleThread(db, request.projectId, "project-orchestrator");
      if (!target || (route === "orchestrator" && target !== request.orchestratorId)) throw new Error(`${route}-head-unresolved`);
      await bb.sdk.threads.send({ threadId: target, mode: "auto", input: [{ type: "text", text: `Alzheimer companion ${route === "director" ? "escalation" : "wake"}: ${judgment.findings} (coverage: ${judgment.coverage}).`, mentions: [] }] });
      snapshots.set(request.projectId, { sentAt: now, fingerprint: judgment.fingerprint, escalatedAt: route === "director" ? now : prior?.fingerprint === judgment.fingerprint ? prior.escalatedAt : undefined });
      await bb.storage.kv.set("backoff", Object.fromEntries(snapshots));
    } catch (error) {
      bb.log.warn(`companion-watcher coverage=blind event=${route} reason=${String(error)}`);
    } finally { db?.close(); }
  };

  bb.events.on("thread.active", ({ thread }) => { activeTurns.set(thread.id, Date.now()); });
  // ponytail: idle-triggered judgment cannot detect silent plugin death; add interval receipts only if silent death is observed.
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    if (pending.has(thread.id)) { await handleJudgment(thread.id, lastAssistantText ?? ""); return; }
    const turnStartedAt = activeTurns.get(thread.id);
    activeTurns.delete(thread.id);
    let db: Database.Database | undefined;
    try {
      const config = await bb.sdk.system.config();
      db = openStore(`${config.dataDir}/plugins/bb-collab/data.db`);
      const orchestratorId = readRoleThread(db, thread.projectId, "project-orchestrator");
      if (thread.id !== orchestratorId || hasActiveWorkers(db, thread.projectId)) return;
      await judge(thread.projectId, orchestratorId, turnStartedAt);
    } catch (error) {
      bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=${String(error)}`);
    } finally { db?.close(); }
  });
}
