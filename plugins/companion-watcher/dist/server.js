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
var BACKOFF_MS = 10 * 6e4;
var ACTIVE = ["prepared", "armed", "content_delivered", "running", "dispatch_unknown"];
function isMergeReady(pr) {
  return pr.state === "OPEN" && pr.mergeStateStatus === "CLEAN" && pr.reviewDecision === "APPROVED" && !!pr.checks?.length && pr.checks.every((check) => check === "SUCCESS");
}
function shouldEscalate(prior, turnStartedAt, fingerprint) {
  return !!prior && prior.fingerprint === fingerprint && !prior.escalated && turnStartedAt !== void 0 && turnStartedAt > prior.sentAt;
}
function openStore(path, onUnavailable) {
  try {
    return new Database(path, { readonly: true, fileMustExist: true });
  } catch (error) {
    onUnavailable(error);
    return void 0;
  }
}
function isWatchedThread(threadId, projectId, orchestrators) {
  return orchestrators.get(projectId) === threadId;
}
function evaluate(db, projectId, queued, startable, prs) {
  const holder = db.prepare(`SELECT a.thread_id AS thread_id FROM role_generation_heads h JOIN role_generations g ON g.project_id=h.project_id AND g.role_id=h.role_id AND g.generation=h.current_generation JOIN execution_attempts a ON a.project_id=g.project_id AND a.execution_attempt_id=g.holder_execution_attempt_id WHERE h.project_id=? AND h.role_id='project-orchestrator'`).get(projectId);
  if (!holder) return [];
  const lane = db.prepare(`SELECT COUNT(*) AS count FROM execution_attempts WHERE project_id=? AND origin='assignment' AND state IN (${ACTIVE.map(() => "?").join(",")})`).get(projectId, ...ACTIVE);
  if (Number(lane.count) > 0) return [];
  const findings = [];
  if (queued.length) findings.push({ condition: "queue", text: `${queued.length} unconsumed queued message${queued.length === 1 ? "" : "s"}`, key: JSON.stringify(queued.map((m) => [m.id, m.content])) });
  const ceiling = db.prepare(`SELECT json_extract(c.canonical_config_json, '$.extensions.bbCollab.writingLaneCeiling') AS ceiling FROM project_config_heads h JOIN project_config_revisions c ON c.project_id=h.project_id AND c.config_revision=h.config_revision WHERE h.project_id=?`).get(projectId)?.ceiling ?? 3;
  if (startable.length && Number(lane.count) < ceiling) findings.push({ condition: "startable", text: `${startable.length} queue:startable issue${startable.length === 1 ? "" : "s"} (${startable.map((n) => `#${n}`).join(", ")}); ${lane.count}/${ceiling} writing lanes active`, key: `${startable.join(",")}:${lane.count}/${ceiling}` });
  const green = prs.filter(isMergeReady);
  if (green.length) findings.push({ condition: "pr", text: green.map((pr) => `PR #${pr.number} merge-ready and unmerged`).join("; "), key: green.map((pr) => pr.number).join(",") });
  return findings;
}
async function json(args) {
  const { stdout } = await exec("gh", args, { timeout: 1e4 });
  return JSON.parse(stdout);
}
function repoName(remote) {
  const match = remote?.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/u);
  return match?.[1] ?? null;
}
async function github(repo) {
  const [issues, prs] = await Promise.all([
    json(["issue", "list", "--repo", repo, "--label", "queue:startable", "--state", "open", "--json", "number", "--limit", "1000"]),
    json(["pr", "list", "--repo", repo, "--state", "open", "--json", "number,state,mergeStateStatus,reviewDecision,statusCheckRollup", "--limit", "1000"])
  ]);
  const issueNumbers = Array.isArray(issues) ? issues.flatMap((x) => typeof x === "object" && x && typeof x.number === "number" ? [x.number] : []) : [];
  const green = Array.isArray(prs) ? prs.flatMap((x) => {
    if (!x || typeof x !== "object" || typeof x.number !== "number") return [];
    const checks = x.statusCheckRollup;
    const pr = x;
    return [{ number: pr.number, state: String(pr.state), mergeStateStatus: String(pr.mergeStateStatus), reviewDecision: String(pr.reviewDecision), checks: Array.isArray(checks) ? checks.flatMap((c) => c && typeof c === "object" ? [String(c.conclusion)] : []) : [] }];
  }) : [];
  return { issues: issueNumbers, prs: green };
}
function companionWatcher(bb) {
  const db = bb.storage.database();
  const snapshots = /* @__PURE__ */ new Map();
  const orchestrators = /* @__PURE__ */ new Map();
  const activeTurns = /* @__PURE__ */ new Map();
  let loaded = false;
  const load = async () => {
    if (loaded) return;
    const saved = await bb.storage.kv.get("backoff");
    if (saved) for (const [key, value] of Object.entries(saved)) snapshots.set(key, value);
    loaded = true;
  };
  bb.events.on("thread.active", ({ thread }) => {
    if (orchestrators.get(thread.projectId) === thread.id) activeTurns.set(thread.id, Date.now());
  });
  bb.events.on("thread.idle", async ({ thread }) => {
    await load();
    const projectId = thread.projectId;
    if (orchestrators.has(projectId) && !isWatchedThread(thread.id, projectId, orchestrators)) return;
    let store;
    try {
      const config = await bb.sdk.system.config();
      store = openStore(`${config.dataDir}/plugins/bb-collab/data.db`, (error) => bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=canonical-store-unavailable:${String(error)}`));
      if (!store) return;
      if (!orchestrators.has(projectId)) {
        const holders = store.prepare(`SELECT a.thread_id, g.project_id FROM role_generation_heads h JOIN role_generations g ON g.project_id=h.project_id AND g.role_id=h.role_id AND g.generation=h.current_generation JOIN execution_attempts a ON a.project_id=g.project_id AND a.execution_attempt_id=g.holder_execution_attempt_id WHERE h.role_id='project-orchestrator'`).all();
        for (const holder of holders) orchestrators.set(holder.project_id, holder.thread_id);
      }
      const target = orchestrators.get(projectId) === thread.id ? { project_id: projectId } : void 0;
      if (!target) return;
      const unknown = store.prepare(`SELECT COUNT(*) AS count FROM execution_attempts WHERE project_id=? AND origin='assignment' AND state='dispatch_unknown'`).get(projectId);
      if (Number(unknown.count) > 0) bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=dispatch_unknown-attempts:${unknown.count}`);
      const queued = await bb.sdk.threads.queuedMessages.list({ threadId: thread.id });
      const { issues, prs } = await github(repoName((await bb.sdk.projects.get({ projectId: target.project_id })).gitRemoteUrl) ?? "");
      const findings = evaluate(store, target.project_id, queued, issues, prs);
      const now = Date.now();
      const send = [];
      for (const finding of findings) {
        const prior = snapshots.get(`${target.project_id}:${finding.condition}`);
        if (!prior || prior.fingerprint !== finding.key || !prior.escalated && now - prior.sentAt >= BACKOFF_MS) send.push(finding);
      }
      const turnStartedAt = activeTurns.get(thread.id);
      activeTurns.delete(thread.id);
      const escalations = findings.filter((finding) => shouldEscalate(snapshots.get(`${target.project_id}:${finding.condition}`), turnStartedAt, finding.key));
      if (!send.length && !escalations.length) return;
      if (send.length) {
        const message = send.map((f) => f.text).join("; ");
        await bb.sdk.threads.send({ threadId: thread.id, mode: "auto", input: [{ type: "text", text: `Companion watcher: ${message}.`, mentions: [] }] });
      }
      for (const finding of send) {
        const key = `${target.project_id}:${finding.condition}`;
        const prior = snapshots.get(key);
        snapshots.set(key, { sentAt: now, fingerprint: finding.key, turns: (prior?.fingerprint === finding.key ? prior.turns : 0) + 1 });
      }
      for (const finding of escalations) {
        const key = `${target.project_id}:${finding.condition}`;
        const prior = snapshots.get(key);
        snapshots.set(key, { ...prior, escalated: true });
        const director = store.prepare(`SELECT a.thread_id AS thread_id FROM role_generation_heads h JOIN role_generations g ON g.project_id=h.project_id AND g.role_id=h.role_id AND g.generation=h.current_generation JOIN execution_attempts a ON a.project_id=g.project_id AND a.execution_attempt_id=g.holder_execution_attempt_id WHERE h.project_id=? AND h.role_id='director'`).get(target.project_id);
        if (director) await bb.sdk.threads.send({ threadId: director.thread_id, mode: "auto", input: [{ type: "text", text: `Companion watcher escalation: ${finding.text}; unchanged after a wake and full turn.`, mentions: [] }] });
      }
      await bb.storage.kv.set("backoff", Object.fromEntries(snapshots));
    } catch (error) {
      bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=canonical-store-unavailable:${String(error)}`);
    } finally {
      store?.close();
    }
  });
}
export {
  companionWatcher as default,
  evaluate,
  isMergeReady,
  isWatchedThread,
  openStore,
  shouldEscalate
};
//# sourceMappingURL=server.js.map
