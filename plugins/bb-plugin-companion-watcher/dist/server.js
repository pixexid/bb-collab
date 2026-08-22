import { createRequire as __createRequire } from "node:module";
import { dirname as __pathDirname } from "node:path";
import { fileURLToPath as __fileURLToPath } from "node:url";
const require = __createRequire(import.meta.url);
var __filename = __fileURLToPath(import.meta.url);
var __dirname = __pathDirname(__filename);

// server.ts
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var exec = promisify(execFile);
var ACTIVE = ["prepared", "armed", "content_delivered", "running", "dispatch_unknown"];
var BACKOFF_MS = 10 * 6e4;
var ESCALATION_HOLD_MS = 24 * 60 * 6e4;
var SNAPSHOT_LIMIT = 100;
var TOOL = "companion_read_snapshot";
var TITLE = "Alzheimer companion judgment";
function parseJudgment(output) {
  const coverages = [...output.matchAll(/^COVERAGE:\s*(known|partial|blind)\s*$/gimu)];
  const escalations = [...output.matchAll(/^ESCALATE:\s*yes\s*$/gimu)];
  const findings = [...output.matchAll(/^FINDING:\s*(.+)\s*$/gimu)].map((match) => match[1].trim());
  const coverage = coverages.length === 1 ? coverages[0][1].toLowerCase() : "blind";
  const illegitimate = escalations.length === 1 && findings.length > 0;
  const text = findings.join("; ").slice(0, 8e3);
  return { coverage, illegitimate, findings: text, fingerprint: text.toLowerCase() };
}
function routeJudgment(prior, judgment, now, turnStartedAt) {
  if (!judgment.illegitimate) return void 0;
  const unchanged = prior?.fingerprint === judgment.fingerprint;
  if (unchanged && turnStartedAt !== void 0 && turnStartedAt > prior.sentAt && (!prior?.escalatedAt || now - prior.escalatedAt >= ESCALATION_HOLD_MS)) return "director";
  if (unchanged && prior?.escalatedAt && now - prior.escalatedAt < ESCALATION_HOLD_MS) return void 0;
  return !unchanged || !prior || now - prior.sentAt >= BACKOFF_MS ? "orchestrator" : void 0;
}
function openStore(path) {
  return new Database(path, { readonly: true, fileMustExist: true });
}
function readRoleThread(db, projectId, roleId) {
  return db.prepare(`SELECT a.thread_id AS thread_id FROM role_generation_heads h JOIN role_generations g ON g.project_id=h.project_id AND g.role_id=h.role_id AND g.generation=h.current_generation JOIN execution_attempts a ON a.project_id=g.project_id AND a.execution_attempt_id=g.holder_execution_attempt_id WHERE h.project_id=? AND h.role_id=?`).get(projectId, roleId)?.thread_id;
}
function hasActiveWorkers(db, projectId) {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM execution_attempts WHERE project_id=? AND origin='work_item' AND state IN (${ACTIVE.map(() => "?").join(",")})`).get(projectId, ...ACTIVE);
  return Number(row.count) > 0;
}
function rows(db, sql, projectId) {
  return db.prepare(sql).all(projectId, SNAPSHOT_LIMIT);
}
async function githubEvidence(remote) {
  const repo = remote?.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/u)?.[1];
  if (!repo) throw new Error("github-repository-unresolved");
  const { stdout } = await exec("gh", ["pr", "list", "--repo", repo, "--state", "open", "--json", "number,title,state,mergeStateStatus,reviewDecision,headRefOid,statusCheckRollup", "--limit", String(SNAPSHOT_LIMIT)], { timeout: 1e4 });
  return JSON.parse(stdout);
}
var prompt = (projectId) => `Judge whether the project orchestrator's current idleness is illegitimate: compare its stated intentions with outcomes and identify undone stated work or work parked without cause. Call ${TOOL} exactly once; do not infer liveness from silence and do not mutate or message anything. Output exactly one anchored line COVERAGE: known|partial|blind. If and only if idleness is illegitimate, add one or more anchored FINDING: lines and the optional anchored affirmative line ESCALATE: yes. Project: ${projectId}.`;
function companionWatcher(bb) {
  const snapshots = /* @__PURE__ */ new Map();
  const companions = /* @__PURE__ */ new Map();
  const pending = /* @__PURE__ */ new Map();
  const activeTurns = /* @__PURE__ */ new Map();
  let loaded = false;
  const load = async () => {
    if (loaded) return;
    const saved = await bb.storage.kv.get("backoff");
    const savedCompanions = await bb.storage.kv.get("companions");
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
      let db;
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
        let github;
        let coverage = queued.length >= SNAPSHOT_LIMIT || executionAttempts.length >= SNAPSHOT_LIMIT || workItems.length >= SNAPSHOT_LIMIT ? "partial" : "known";
        try {
          github = await githubEvidence(project.gitRemoteUrl);
        } catch (error) {
          coverage = "blind";
          github = { error: String(error) };
        }
        return JSON.stringify({ coverage, orchestratorId, recentTimeline, queued: queued.slice(0, SNAPSHOT_LIMIT), executionAttempts, workItems, github });
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: `COVERAGE: blind
snapshot read failed: ${String(error)}` }] };
      } finally {
        db?.close();
      }
    }
  });
  bb.agents.configure((context) => context.origin.pluginId === bb.pluginId && context.thread.title === TITLE ? { tools: [TOOL], skills: [] } : { tools: [], skills: [] });
  const judge = async (projectId, orchestratorId, turnStartedAt) => {
    await load();
    let threadId = companions.get(projectId);
    if (threadId) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.projectId !== projectId || thread.status !== "idle") return;
      } catch {
        companions.delete(projectId);
        threadId = void 0;
      }
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
  const handleJudgment = async (threadId, output) => {
    const request = pending.get(threadId);
    if (!request) return;
    pending.delete(threadId);
    const judgment = parseJudgment(output);
    const prior = snapshots.get(request.projectId);
    const now = Date.now();
    const route = routeJudgment(prior, judgment, now, request.turnStartedAt);
    bb.log.info(`companion-watcher coverage=${judgment.coverage} event=judgment illegitimate=${judgment.illegitimate} route=${route ?? "silence"}`);
    if (!route) return;
    let db;
    try {
      const config = await bb.sdk.system.config();
      db = openStore(`${config.dataDir}/plugins/bb-collab/data.db`);
      const target = route === "director" ? readRoleThread(db, request.projectId, "director") : readRoleThread(db, request.projectId, "project-orchestrator");
      if (!target || route === "orchestrator" && target !== request.orchestratorId) throw new Error(`${route}-head-unresolved`);
      await bb.sdk.threads.send({ threadId: target, mode: "auto", input: [{ type: "text", text: `Alzheimer companion ${route === "director" ? "escalation" : "wake"}: ${judgment.findings} (coverage: ${judgment.coverage}).`, mentions: [] }] });
      snapshots.set(request.projectId, { sentAt: now, fingerprint: judgment.fingerprint, escalatedAt: route === "director" ? now : prior?.fingerprint === judgment.fingerprint ? prior.escalatedAt : void 0 });
      await bb.storage.kv.set("backoff", Object.fromEntries(snapshots));
    } catch (error) {
      bb.log.warn(`companion-watcher coverage=blind event=${route} reason=${String(error)}`);
    } finally {
      db?.close();
    }
  };
  bb.events.on("thread.active", ({ thread }) => {
    activeTurns.set(thread.id, Date.now());
  });
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    if (pending.has(thread.id)) {
      await handleJudgment(thread.id, lastAssistantText ?? "");
      return;
    }
    const turnStartedAt = activeTurns.get(thread.id);
    activeTurns.delete(thread.id);
    let db;
    try {
      const config = await bb.sdk.system.config();
      db = openStore(`${config.dataDir}/plugins/bb-collab/data.db`);
      const orchestratorId = readRoleThread(db, thread.projectId, "project-orchestrator");
      if (thread.id !== orchestratorId || hasActiveWorkers(db, thread.projectId)) return;
      await judge(thread.projectId, orchestratorId, turnStartedAt);
    } catch (error) {
      bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=${String(error)}`);
    } finally {
      db?.close();
    }
  });
}
export {
  companionWatcher as default,
  hasActiveWorkers,
  openStore,
  parseJudgment,
  readRoleThread,
  routeJudgment
};
//# sourceMappingURL=server.js.map
