import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BbPluginApi } from "@bb/plugin-sdk";

const exec = promisify(execFile);
const BACKOFF_MS = 10 * 60_000;
const ACTIVE = ["prepared", "armed", "content_delivered", "running", "dispatch_unknown"];
type Condition = "queue" | "pr";
type Finding = { condition: Condition; text: string; key: string };
type PullRequest = { number: number; state?: string; mergeStateStatus?: string; reviewDecision?: string; headCommitOid?: string; approvedCommitOids?: readonly string[]; checks?: readonly string[] };
type Snapshot = { sentAt: number; fingerprint: string; turns: number; escalated?: boolean };
const STARTUP_RETRY_ATTEMPTS = 3;

export function isMergeReady(pr: PullRequest): boolean {
  return pr.state === "OPEN" && pr.mergeStateStatus === "CLEAN" && pr.reviewDecision === "APPROVED" && !!pr.headCommitOid && pr.approvedCommitOids?.includes(pr.headCommitOid) === true && !!pr.checks?.length && pr.checks.every((check) => check === "SUCCESS");
}

function missing(path: string): Error {
  return new Error(`github-payload-invalid:missing-${path}`);
}

export function parsePullRequests(value: unknown, onInvalid: (error: unknown) => void = () => {}): PullRequest[] {
  if (!Array.isArray(value)) throw new Error("github-payload-invalid:pull-requests-not-array");
  return value.flatMap((item, index) => {
    try {
      if (!item || typeof item !== "object") throw new Error(`github-payload-invalid:pr-${index}-not-object`);
      const pr = item as Record<string, unknown>;
      for (const field of ["number", "state", "mergeStateStatus", "reviewDecision", "headRefOid", "reviews", "statusCheckRollup"]) {
        if (!(field in pr)) throw missing(`pr-${index}-${field}`);
      }
      if (typeof pr.number !== "number" || typeof pr.state !== "string" || (pr.mergeStateStatus !== null && typeof pr.mergeStateStatus !== "string") || (pr.reviewDecision !== null && typeof pr.reviewDecision !== "string") || typeof pr.headRefOid !== "string" || !Array.isArray(pr.reviews) || !Array.isArray(pr.statusCheckRollup)) throw new Error(`github-payload-invalid:pr-${index}-field-type`);
      const approvedCommitOids = pr.reviews.map((review, reviewIndex) => {
        if (!review || typeof review !== "object" || typeof (review as { state?: unknown }).state !== "string") throw new Error(`github-payload-invalid:pr-${index}-review-${reviewIndex}`);
        if ((review as { state: string }).state !== "APPROVED") return null;
        const oid = (review as { commit?: { oid?: unknown } }).commit?.oid;
        if (typeof oid !== "string") throw missing(`pr-${index}-approved-review-${reviewIndex}-commit`);
        return oid;
      }).filter((oid): oid is string => oid !== null);
      const checks = pr.statusCheckRollup.map((check, checkIndex) => {
        if (!check || typeof check !== "object") throw new Error(`github-payload-invalid:pr-${index}-check-${checkIndex}`);
        if ("conclusion" in check) {
          const conclusion = (check as { conclusion?: unknown }).conclusion;
          if (conclusion !== null && typeof conclusion !== "string") throw new Error(`github-payload-invalid:pr-${index}-check-${checkIndex}`);
          return conclusion ?? "";
        }
        if ("state" in check && typeof (check as { state?: unknown }).state === "string") return (check as { state: string }).state;
        throw new Error(`github-payload-invalid:pr-${index}-check-${checkIndex}`);
      });
      return [{ number: pr.number, state: pr.state, mergeStateStatus: pr.mergeStateStatus ?? undefined, reviewDecision: pr.reviewDecision ?? undefined, headCommitOid: pr.headRefOid, approvedCommitOids, checks }];
    } catch (error) {
      onInvalid(error);
      return [];
    }
  });
}
export function shouldEscalate(prior: Snapshot | undefined, turnStartedAt: number | undefined, fingerprint: string): boolean {
  return !!prior && prior.fingerprint === fingerprint && !prior.escalated && turnStartedAt !== undefined && turnStartedAt > prior.sentAt;
}
export function reserveSnapshot(snapshots: Map<string, Snapshot>, key: string, next: Snapshot): { commit: () => void; rollback: () => void } {
  const prior = snapshots.get(key);
  let settled = false;
  snapshots.set(key, next);
  return {
    commit: () => { settled = true; },
    rollback: () => {
      if (settled) return;
      if (prior) snapshots.set(key, prior);
      else snapshots.delete(key);
      settled = true;
    },
  };
}

export async function retryStartup(reconcile: () => Promise<void>, attempts: number): Promise<unknown | undefined> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { await reconcile(); return undefined; } catch (error) { lastError = error; }
  }
  return lastError;
}

export function dispatchPlan(findings: readonly Finding[], snapshots: ReadonlyMap<string, Snapshot>, projectId: string, now: number, turnStartedAt: number | undefined): { send: Finding[]; escalations: Finding[] } {
  const escalations = findings.filter((finding) => shouldEscalate(snapshots.get(`${projectId}:${finding.condition}`), turnStartedAt, finding.key));
  const escalationKeys = new Set(escalations.map((finding) => finding.condition));
  const send = findings.filter((finding) => {
    const prior = snapshots.get(`${projectId}:${finding.condition}`);
    return !escalationKeys.has(finding.condition) && (!prior || prior.fingerprint !== finding.key || (!prior.escalated && now - prior.sentAt >= BACKOFF_MS));
  });
  return { send, escalations };
}
export function openStore(path: string, onUnavailable: (error: unknown) => void): Database.Database | undefined {
  try { return new Database(path, { readonly: true, fileMustExist: true }); } catch (error) { onUnavailable(error); return undefined; }
}
export function readOrchestrator(db: Database.Database, projectId: string): string | undefined {
  return (db.prepare(`SELECT a.thread_id AS thread_id FROM role_generation_heads h JOIN role_generations g ON g.project_id=h.project_id AND g.role_id=h.role_id AND g.generation=h.current_generation JOIN execution_attempts a ON a.project_id=g.project_id AND a.execution_attempt_id=g.holder_execution_attempt_id WHERE h.project_id=? AND h.role_id='project-orchestrator'`).get(projectId) as { thread_id: string } | undefined)?.thread_id;
}
export function coverageReason(kind: "store" | "github" | "sdk" | "wake", error: unknown): string {
  return `${kind === "store" ? "canonical-store-unavailable" : kind === "github" ? "github-unavailable" : kind === "wake" ? "wake-delivery-failed" : "sdk-unavailable"}:${String(error)}`;
}

function firstLine(content: unknown): string {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.find((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string")?.text : undefined;
  return typeof text === "string" ? text.split("\n", 1)[0] : "(unreadable)";
}

export function evaluate(db: Database.Database, projectId: string, queued: readonly { id?: string; content?: unknown }[], prs: readonly PullRequest[]): Finding[] {
  const holder = db.prepare(`SELECT a.thread_id AS thread_id FROM role_generation_heads h JOIN role_generations g ON g.project_id=h.project_id AND g.role_id=h.role_id AND g.generation=h.current_generation JOIN execution_attempts a ON a.project_id=g.project_id AND a.execution_attempt_id=g.holder_execution_attempt_id WHERE h.project_id=? AND h.role_id='project-orchestrator'`).get(projectId) as { thread_id: string } | undefined;
  if (!holder) return [];
  const lane = db.prepare(`SELECT COUNT(*) AS count FROM execution_attempts WHERE project_id=? AND origin='work_item' AND state IN (${ACTIVE.map(() => "?").join(",")})`).get(projectId, ...ACTIVE) as { count: number };
  if (Number(lane.count) > 0) return [];
  const findings: Finding[] = [];
  if (queued.length) findings.push({ condition: "queue", text: `${queued.length} unconsumed queued message${queued.length === 1 ? "" : "s"}: ${queued.map((m) => `"${firstLine(m.content)}"`).join(", ")}`, key: JSON.stringify(queued.map((m) => [m.id, m.content])) });
  const green = prs.filter(isMergeReady);
  if (green.length) findings.push({
    condition: "pr",
    text: green.map((pr) => `PR #${pr.number} merge-ready and unmerged`).join("; "),
    key: JSON.stringify(green.map((pr) => [pr.number, pr.headCommitOid, pr.approvedCommitOids, pr.checks])),
  });
  return findings;
}

async function json(args: string[]): Promise<unknown> {
  const { stdout } = await exec("gh", args, { timeout: 10_000 });
  return JSON.parse(stdout);
}
function repoName(remote: string | null): string | null {
  const match = remote?.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/u);
  return match?.[1] ?? null;
}
async function github(repo: string, onInvalid: (error: unknown) => void): Promise<PullRequest[]> {
  const prs = await json(["pr", "list", "--repo", repo, "--state", "open", "--json", "number,state,mergeStateStatus,reviewDecision,headRefOid,reviews,statusCheckRollup", "--limit", "1000"]);
  return parsePullRequests(prs, onInvalid);
}

export default function companionWatcher(bb: BbPluginApi) {
  const snapshots = new Map<string, Snapshot>();
  const activeTurns = new Map<string, number>();
  let loaded = false;
  const load = async () => {
    if (loaded) return;
    const saved = await bb.storage.kv.get<Record<string, Snapshot>>("backoff");
    if (saved) for (const [key, value] of Object.entries(saved)) snapshots.set(key, value);
    loaded = true;
  };
  bb.events.on("thread.active", ({ thread }) => {
    activeTurns.set(thread.id, Date.now());
  });
  const handleIdle = async (thread: { id: string; projectId: string }, turnStartedAt?: number) => {
    try {
      await load();
    } catch (error) {
      bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=${coverageReason("sdk", error)}`);
      return;
    }
    const projectId = thread.projectId;
    activeTurns.delete(thread.id);
    let store: Database.Database | undefined;
    try {
      let config: Awaited<ReturnType<typeof bb.sdk.system.config>>;
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
      const unknown = store.prepare(`SELECT COUNT(*) AS count FROM execution_attempts WHERE project_id=? AND origin='work_item' AND state='dispatch_unknown'`).get(projectId) as { count: number };
      if (Number(unknown.count) > 0) bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=dispatch_unknown-attempts:${unknown.count}`);
      let queued: Awaited<ReturnType<typeof bb.sdk.threads.queuedMessages.list>>;
      let remote: string | null;
      try {
        queued = await bb.sdk.threads.queuedMessages.list({ threadId: thread.id });
        remote = (await bb.sdk.projects.get({ projectId: target.project_id })).gitRemoteUrl;
      } catch (error) {
        bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=${coverageReason("sdk", error)}`);
        return;
      }
      let prs: PullRequest[];
      try {
        prs = await github(repoName(remote) ?? "", (error) => bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=${coverageReason("github", error)}`));
      } catch (error) {
        bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=${coverageReason("github", error)}`);
        return;
      }
      const findings = evaluate(store, target.project_id, queued as never, prs);
      const now = Date.now();
      const { send, escalations } = dispatchPlan(findings, snapshots, target.project_id, now, turnStartedAt);
      if (!send.length && !escalations.length) return;
      const reservations = new Map<string, ReturnType<typeof reserveSnapshot>>();
      const reserve = (key: string, snapshot: Snapshot) => reservations.set(key, reserveSnapshot(snapshots, key, snapshot));
      const commit = (keys: readonly string[]) => keys.forEach((key) => reservations.get(key)?.commit());
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
        const prior = snapshots.get(key)!;
        const director = store.prepare(`SELECT a.thread_id AS thread_id FROM role_generation_heads h JOIN role_generations g ON g.project_id=h.project_id AND g.role_id=h.role_id AND g.generation=h.current_generation JOIN execution_attempts a ON a.project_id=g.project_id AND a.execution_attempt_id=g.holder_execution_attempt_id WHERE h.project_id=? AND h.role_id='director'`).get(target.project_id) as { thread_id: string } | undefined;
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
    } finally { store?.close(); }
  };
  bb.events.on("thread.idle", ({ thread }) => handleIdle(thread, activeTurns.get(thread.id)));
  bb.background.service("startup-reconciliation", {
    start: async (signal) => {
      const startupError = await retryStartup(async () => {
        for (let offset = 0; ; offset += 1000) {
          const threads = await bb.sdk.threads.list({ archived: false, limit: 1000, offset });
          for (const thread of threads) if (thread.status === "idle") await handleIdle(thread);
          if (threads.length < 1000) break;
        }
      }, STARTUP_RETRY_ATTEMPTS);
      if (startupError) bb.log.warn(`companion-watcher coverage=blind event=startup reason=${coverageReason("sdk", startupError)}`);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  });
}
