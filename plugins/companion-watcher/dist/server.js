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
var STARTUP_RETRY_ATTEMPTS = 3;
function isMergeReady(pr) {
  return pr.state === "OPEN" && pr.mergeStateStatus === "CLEAN" && pr.reviewDecision === "APPROVED" && !!pr.headCommitOid && pr.approvedCommitOids?.includes(pr.headCommitOid) === true && !!pr.checks?.length && pr.checks.every((check) => check === "SUCCESS");
}
function missing(path) {
  return new Error(`github-payload-invalid:missing-${path}`);
}
function parsePullRequests(value, onInvalid = () => {
}) {
  if (!Array.isArray(value)) throw new Error("github-payload-invalid:pull-requests-not-array");
  return value.flatMap((item, index) => {
    try {
      if (!item || typeof item !== "object") throw new Error(`github-payload-invalid:pr-${index}-not-object`);
      const pr = item;
      for (const field of ["number", "state", "mergeStateStatus", "reviewDecision", "headRefOid", "reviews", "statusCheckRollup"]) {
        if (!(field in pr)) throw missing(`pr-${index}-${field}`);
      }
      if (typeof pr.number !== "number" || typeof pr.state !== "string" || pr.mergeStateStatus !== null && typeof pr.mergeStateStatus !== "string" || pr.reviewDecision !== null && typeof pr.reviewDecision !== "string" || typeof pr.headRefOid !== "string" || !Array.isArray(pr.reviews) || !Array.isArray(pr.statusCheckRollup)) throw new Error(`github-payload-invalid:pr-${index}-field-type`);
      const approvedCommitOids = pr.reviews.map((review, reviewIndex) => {
        if (!review || typeof review !== "object" || typeof review.state !== "string") throw new Error(`github-payload-invalid:pr-${index}-review-${reviewIndex}`);
        if (review.state !== "APPROVED") return null;
        const oid = review.commit?.oid;
        if (typeof oid !== "string") throw missing(`pr-${index}-approved-review-${reviewIndex}-commit`);
        return oid;
      }).filter((oid) => oid !== null);
      const checks = pr.statusCheckRollup.map((check, checkIndex) => {
        if (!check || typeof check !== "object") throw new Error(`github-payload-invalid:pr-${index}-check-${checkIndex}`);
        if ("conclusion" in check) {
          const conclusion = check.conclusion;
          if (conclusion !== null && typeof conclusion !== "string") throw new Error(`github-payload-invalid:pr-${index}-check-${checkIndex}`);
          return conclusion ?? "";
        }
        if ("state" in check && typeof check.state === "string") return check.state;
        throw new Error(`github-payload-invalid:pr-${index}-check-${checkIndex}`);
      });
      return [{ number: pr.number, state: pr.state, mergeStateStatus: pr.mergeStateStatus ?? void 0, reviewDecision: pr.reviewDecision ?? void 0, headCommitOid: pr.headRefOid, approvedCommitOids, checks }];
    } catch (error) {
      onInvalid(error);
      return [];
    }
  });
}
function shouldEscalate(prior, turnStartedAt, fingerprint) {
  return !!prior && prior.fingerprint === fingerprint && !prior.escalated && turnStartedAt !== void 0 && turnStartedAt > prior.sentAt;
}
function reserveSnapshot(snapshots, key, next) {
  const prior = snapshots.get(key);
  let settled = false;
  snapshots.set(key, next);
  return {
    commit: () => {
      settled = true;
    },
    rollback: () => {
      if (settled) return;
      if (prior) snapshots.set(key, prior);
      else snapshots.delete(key);
      settled = true;
    }
  };
}
async function retryStartup(reconcile, attempts) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await reconcile();
      return void 0;
    } catch (error) {
      lastError = error;
    }
  }
  return lastError;
}
function dispatchPlan(findings, snapshots, projectId, now, turnStartedAt) {
  const escalations = findings.filter((finding) => shouldEscalate(snapshots.get(`${projectId}:${finding.condition}`), turnStartedAt, finding.key));
  const escalationKeys = new Set(escalations.map((finding) => finding.condition));
  const send = findings.filter((finding) => {
    const prior = snapshots.get(`${projectId}:${finding.condition}`);
    return !escalationKeys.has(finding.condition) && (!prior || prior.fingerprint !== finding.key || !prior.escalated && now - prior.sentAt >= BACKOFF_MS);
  });
  return { send, escalations };
}
function openStore(path, onUnavailable) {
  try {
    return new Database(path, { readonly: true, fileMustExist: true });
  } catch (error) {
    onUnavailable(error);
    return void 0;
  }
}
function readOrchestrator(db, projectId) {
  return db.prepare(`SELECT a.thread_id AS thread_id FROM role_generation_heads h JOIN role_generations g ON g.project_id=h.project_id AND g.role_id=h.role_id AND g.generation=h.current_generation JOIN execution_attempts a ON a.project_id=g.project_id AND a.execution_attempt_id=g.holder_execution_attempt_id WHERE h.project_id=? AND h.role_id='project-orchestrator'`).get(projectId)?.thread_id;
}
function coverageReason(kind, error) {
  return `${kind === "store" ? "canonical-store-unavailable" : kind === "github" ? "github-unavailable" : kind === "wake" ? "wake-delivery-failed" : "sdk-unavailable"}:${String(error)}`;
}
function firstLine(content) {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.find((part) => part && typeof part === "object" && typeof part.text === "string")?.text : void 0;
  return typeof text === "string" ? text.split("\n", 1)[0] : "(unreadable)";
}
function evaluate(db, projectId, queued, startable, prs) {
  const holder = db.prepare(`SELECT a.thread_id AS thread_id FROM role_generation_heads h JOIN role_generations g ON g.project_id=h.project_id AND g.role_id=h.role_id AND g.generation=h.current_generation JOIN execution_attempts a ON a.project_id=g.project_id AND a.execution_attempt_id=g.holder_execution_attempt_id WHERE h.project_id=? AND h.role_id='project-orchestrator'`).get(projectId);
  if (!holder) return [];
  const lane = db.prepare(`SELECT COUNT(*) AS count FROM execution_attempts WHERE project_id=? AND origin='assignment' AND state IN (${ACTIVE.map(() => "?").join(",")})`).get(projectId, ...ACTIVE);
  if (Number(lane.count) > 0) return [];
  const findings = [];
  if (queued.length) findings.push({ condition: "queue", text: `${queued.length} unconsumed queued message${queued.length === 1 ? "" : "s"}: ${queued.map((m) => `"${firstLine(m.content)}"`).join(", ")}`, key: JSON.stringify(queued.map((m) => [m.id, m.content])) });
  const ceiling = db.prepare(`SELECT json_extract(c.canonical_config_json, '$.extensions.bbCollab.writingLaneCeiling') AS ceiling FROM project_config_heads h JOIN project_config_revisions c ON c.project_id=h.project_id AND c.config_revision=h.config_revision WHERE h.project_id=?`).get(projectId)?.ceiling ?? 3;
  if (startable.length && Number(lane.count) < ceiling) findings.push({ condition: "startable", text: `${startable.length} queue:startable issue${startable.length === 1 ? "" : "s"} (${startable.map((issue) => `#${issue.number} ${issue.title} [${issue.labels.join(", ")}]`).join(", ")}); ${lane.count}/${ceiling} writing lanes active`, key: JSON.stringify([startable, lane.count, ceiling]) });
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
function parseStartableIssues(value, onInvalid = () => {
}) {
  if (!Array.isArray(value)) throw new Error("github-payload-invalid:startable-not-array");
  return value.flatMap((item, index) => {
    try {
      if (!item || typeof item !== "object") throw new Error(`github-payload-invalid:startable-${index}-not-object`);
      const issue = item;
      for (const field of ["number", "title", "labels"]) if (!(field in issue)) throw missing(`startable-${index}-${field}`);
      if (typeof issue.number !== "number" || typeof issue.title !== "string" || !Array.isArray(issue.labels)) throw new Error(`github-payload-invalid:startable-${index}-field-type`);
      const labels = issue.labels.map((label, labelIndex) => {
        if (!label || typeof label !== "object" || typeof label.name !== "string") throw new Error(`github-payload-invalid:startable-${index}-label-${labelIndex}`);
        return label.name;
      });
      return [{ number: issue.number, title: issue.title, labels }];
    } catch (error) {
      onInvalid(error);
      return [];
    }
  });
}
async function github(repo, onInvalid) {
  const [issues, prs] = await Promise.all([
    json(["issue", "list", "--repo", repo, "--label", "queue:startable", "--state", "open", "--json", "number,title,labels", "--limit", "1000"]),
    json(["pr", "list", "--repo", repo, "--state", "open", "--json", "number,state,mergeStateStatus,reviewDecision,headRefOid,reviews,statusCheckRollup", "--limit", "1000"])
  ]);
  return { issues: parseStartableIssues(issues, onInvalid), prs: parsePullRequests(prs, onInvalid) };
}
function companionWatcher(bb) {
  const snapshots = /* @__PURE__ */ new Map();
  const activeTurns = /* @__PURE__ */ new Map();
  let loaded = false;
  const load = async () => {
    if (loaded) return;
    const saved = await bb.storage.kv.get("backoff");
    if (saved) for (const [key, value] of Object.entries(saved)) snapshots.set(key, value);
    loaded = true;
  };
  bb.events.on("thread.active", ({ thread }) => {
    activeTurns.set(thread.id, Date.now());
  });
  const handleIdle = async (thread, turnStartedAt) => {
    try {
      await load();
    } catch (error) {
      bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=${coverageReason("sdk", error)}`);
      return;
    }
    const projectId = thread.projectId;
    activeTurns.delete(thread.id);
    let store;
    try {
      let config;
      try {
        config = await bb.sdk.system.config();
      } catch (error) {
        bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=${coverageReason("sdk", error)}`);
        return;
      }
      store = openStore(`${config.dataDir}/plugins/bb-collab/data.db`, (error) => bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=${coverageReason("store", error)}`));
      if (!store) return;
      const orchestrator = readOrchestrator(store, projectId);
      if (!orchestrator) {
        bb.log.warn("companion-watcher coverage=blind event=thread.idle reason=orchestrator-head-unresolved");
        return;
      }
      if (orchestrator !== thread.id) return;
      const target = { project_id: projectId };
      const unknown = store.prepare(`SELECT COUNT(*) AS count FROM execution_attempts WHERE project_id=? AND origin='assignment' AND state='dispatch_unknown'`).get(projectId);
      if (Number(unknown.count) > 0) bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=dispatch_unknown-attempts:${unknown.count}`);
      let queued;
      let remote;
      try {
        queued = await bb.sdk.threads.queuedMessages.list({ threadId: thread.id });
        remote = (await bb.sdk.projects.get({ projectId: target.project_id })).gitRemoteUrl;
      } catch (error) {
        bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=${coverageReason("sdk", error)}`);
        return;
      }
      let issues, prs;
      try {
        ({ issues, prs } = await github(repoName(remote) ?? "", (error) => bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=${coverageReason("github", error)}`)));
      } catch (error) {
        bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=${coverageReason("github", error)}`);
        return;
      }
      const findings = evaluate(store, target.project_id, queued, issues, prs);
      const now = Date.now();
      const { send, escalations } = dispatchPlan(findings, snapshots, target.project_id, now, turnStartedAt);
      if (!send.length && !escalations.length) return;
      const reservations = /* @__PURE__ */ new Map();
      const reserve = (key, snapshot) => reservations.set(key, reserveSnapshot(snapshots, key, snapshot));
      const commit = (keys) => keys.forEach((key) => reservations.get(key)?.commit());
      const rollback = () => reservations.forEach((reservation) => reservation.rollback());
      for (const finding of send) {
        const key = `${target.project_id}:${finding.condition}`;
        const prior = snapshots.get(key);
        reserve(key, { sentAt: now, fingerprint: finding.key, turns: (prior?.fingerprint === finding.key ? prior.turns : 0) + 1 });
      }
      if (send.length) {
        const message = send.map((f) => f.text).join("; ");
        try {
          await bb.sdk.threads.send({ threadId: thread.id, mode: "auto", input: [{ type: "text", text: `Companion watcher: ${message}.`, mentions: [] }] });
        } catch (error) {
          rollback();
          bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=${coverageReason("wake", error)}`);
          return;
        }
        commit(send.map((finding) => `${target.project_id}:${finding.condition}`));
      }
      for (const finding of escalations) {
        const key = `${target.project_id}:${finding.condition}`;
        const prior = snapshots.get(key);
        const director = store.prepare(`SELECT a.thread_id AS thread_id FROM role_generation_heads h JOIN role_generations g ON g.project_id=h.project_id AND g.role_id=h.role_id AND g.generation=h.current_generation JOIN execution_attempts a ON a.project_id=g.project_id AND a.execution_attempt_id=g.holder_execution_attempt_id WHERE h.project_id=? AND h.role_id='director'`).get(target.project_id);
        if (!director) {
          bb.log.warn("companion-watcher coverage=blind event=thread.idle reason=director-unavailable");
          continue;
        }
        reserve(key, { ...prior, escalated: true });
        try {
          await bb.sdk.threads.send({ threadId: director.thread_id, mode: "auto", input: [{ type: "text", text: `Companion watcher escalation: ${finding.text}; unchanged after a wake and full turn.`, mentions: [] }] });
          commit([key]);
        } catch (error) {
          rollback();
          bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=${coverageReason("wake", error)}`);
          return;
        }
      }
      try {
        await bb.storage.kv.set("backoff", Object.fromEntries(snapshots));
      } catch (error) {
        bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=${coverageReason("sdk", error)}`);
      }
    } catch (error) {
      bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=${coverageReason("store", error)}`);
    } finally {
      store?.close();
    }
  };
  bb.events.on("thread.idle", ({ thread }) => handleIdle(thread, activeTurns.get(thread.id)));
  bb.background.service("startup-reconciliation", {
    start: async (signal) => {
      const startupError = await retryStartup(async () => {
        for (let offset = 0; ; offset += 1e3) {
          const threads = await bb.sdk.threads.list({ archived: false, limit: 1e3, offset });
          for (const thread of threads) if (thread.status === "idle") await handleIdle(thread);
          if (threads.length < 1e3) break;
        }
      }, STARTUP_RETRY_ATTEMPTS);
      if (startupError) bb.log.warn(`companion-watcher coverage=blind event=startup reason=${coverageReason("sdk", startupError)}`);
      await new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
  });
}
export {
  coverageReason,
  companionWatcher as default,
  dispatchPlan,
  evaluate,
  isMergeReady,
  openStore,
  parsePullRequests,
  parseStartableIssues,
  readOrchestrator,
  reserveSnapshot,
  retryStartup,
  shouldEscalate
};
//# sourceMappingURL=server.js.map
