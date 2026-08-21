import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BbPluginApi } from "@bb/plugin-sdk";

const exec = promisify(execFile);
const BACKOFF_MS = 10 * 60_000;
const ACTIVE = ["prepared", "armed", "content_delivered", "running", "dispatch_unknown"];
type Condition = "queue" | "startable" | "pr";
type Finding = { condition: Condition; text: string; key: string };
type PullRequest = { number: number; state?: string; mergeStateStatus?: string; reviewDecision?: string; checks?: readonly string[] };
type Snapshot = { sentAt: number; fingerprint: string; turns: number; escalated?: boolean };

export function isMergeReady(pr: PullRequest): boolean {
  return pr.state === "OPEN" && pr.mergeStateStatus === "CLEAN" && pr.reviewDecision === "APPROVED" && !!pr.checks?.length && pr.checks.every((check) => check === "SUCCESS");
}
export function shouldEscalate(prior: Snapshot | undefined, turnStartedAt: number | undefined, fingerprint: string): boolean {
  return !!prior && prior.fingerprint === fingerprint && !prior.escalated && turnStartedAt !== undefined && turnStartedAt > prior.sentAt;
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

export function evaluate(db: Database.Database, projectId: string, queued: readonly { id?: string; content?: unknown }[], startable: readonly number[], prs: readonly PullRequest[]): Finding[] {
  const holder = db.prepare(`SELECT a.thread_id AS thread_id FROM role_generation_heads h JOIN role_generations g ON g.project_id=h.project_id AND g.role_id=h.role_id AND g.generation=h.current_generation JOIN execution_attempts a ON a.project_id=g.project_id AND a.execution_attempt_id=g.holder_execution_attempt_id WHERE h.project_id=? AND h.role_id='project-orchestrator'`).get(projectId) as { thread_id: string } | undefined;
  if (!holder) return [];
  const lane = db.prepare(`SELECT COUNT(*) AS count FROM execution_attempts WHERE project_id=? AND origin='assignment' AND state IN (${ACTIVE.map(() => "?").join(",")})`).get(projectId, ...ACTIVE) as { count: number };
  if (Number(lane.count) > 0) return [];
  const findings: Finding[] = [];
  if (queued.length) findings.push({ condition: "queue", text: `${queued.length} unconsumed queued message${queued.length === 1 ? "" : "s"}`, key: JSON.stringify(queued.map((m) => [m.id, m.content])) });
  const ceiling = (db.prepare(`SELECT json_extract(c.canonical_config_json, '$.extensions.bbCollab.writingLaneCeiling') AS ceiling FROM project_config_heads h JOIN project_config_revisions c ON c.project_id=h.project_id AND c.config_revision=h.config_revision WHERE h.project_id=?`).get(projectId) as { ceiling: number | null } | undefined)?.ceiling ?? 3;
  if (startable.length && Number(lane.count) < ceiling) findings.push({ condition: "startable", text: `${startable.length} queue:startable issue${startable.length === 1 ? "" : "s"} (${startable.map((n) => `#${n}`).join(", ")}); ${lane.count}/${ceiling} writing lanes active`, key: `${startable.join(",")}:${lane.count}/${ceiling}` });
  const green = prs.filter(isMergeReady);
  if (green.length) findings.push({ condition: "pr", text: green.map((pr) => `PR #${pr.number} merge-ready and unmerged`).join("; "), key: green.map((pr) => pr.number).join(",") });
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
async function github(repo: string): Promise<{ issues: number[]; prs: PullRequest[] }> {
  const [issues, prs] = await Promise.all([
    json(["issue", "list", "--repo", repo, "--label", "queue:startable", "--state", "open", "--json", "number", "--limit", "1000"]),
    json(["pr", "list", "--repo", repo, "--state", "open", "--json", "number,state,mergeStateStatus,reviewDecision,statusCheckRollup", "--limit", "1000"]),
  ]);
  const issueNumbers = Array.isArray(issues) ? issues.flatMap((x) => typeof x === "object" && x && typeof (x as { number?: unknown }).number === "number" ? [(x as { number: number }).number] : []) : [];
  const green = Array.isArray(prs) ? prs.flatMap((x) => {
    if (!x || typeof x !== "object" || typeof (x as { number?: unknown }).number !== "number") return [];
    const checks = (x as { statusCheckRollup?: unknown }).statusCheckRollup;
    const pr = x as { number: number; state?: unknown; mergeStateStatus?: unknown; reviewDecision?: unknown };
    return [{ number: pr.number, state: String(pr.state), mergeStateStatus: String(pr.mergeStateStatus), reviewDecision: String(pr.reviewDecision), checks: Array.isArray(checks) ? checks.flatMap((c) => c && typeof c === "object" ? [String((c as { conclusion?: unknown }).conclusion)] : []) : [] }];
  }) : [];
  return { issues: issueNumbers, prs: green };
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
  bb.events.on("thread.idle", async ({ thread }) => {
    try {
      await load();
    } catch (error) {
      bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=${coverageReason("sdk", error)}`);
      return;
    }
    const projectId = thread.projectId;
    const turnStartedAt = activeTurns.get(thread.id);
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
      const unknown = store.prepare(`SELECT COUNT(*) AS count FROM execution_attempts WHERE project_id=? AND origin='assignment' AND state='dispatch_unknown'`).get(projectId) as { count: number };
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
      let issues: number[], prs: PullRequest[];
      try {
        ({ issues, prs } = await github(repoName(remote) ?? ""));
      } catch (error) {
        bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=${coverageReason("github", error)}`);
        return;
      }
      const findings = evaluate(store, target.project_id, queued as never, issues, prs);
      const now = Date.now();
      const send: Finding[] = [];
      for (const finding of findings) {
        const prior = snapshots.get(`${target.project_id}:${finding.condition}`);
        if (!prior || prior.fingerprint !== finding.key || (!prior.escalated && now - prior.sentAt >= BACKOFF_MS)) send.push(finding);
      }
      const escalations = findings.filter((finding) => shouldEscalate(snapshots.get(`${target.project_id}:${finding.condition}`), turnStartedAt, finding.key));
      if (!send.length && !escalations.length) return;
      if (send.length) {
        const message = send.map((f) => f.text).join("; ");
        try {
          await bb.sdk.threads.send({ threadId: thread.id, mode: "auto", input: [{ type: "text", text: `Companion watcher: ${message}.`, mentions: [] }] });
        } catch (error) {
          bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=${coverageReason("wake", error)}`);
          return;
        }
      }
      for (const finding of send) {
        const key = `${target.project_id}:${finding.condition}`;
        const prior = snapshots.get(key);
        snapshots.set(key, { sentAt: now, fingerprint: finding.key, turns: (prior?.fingerprint === finding.key ? prior.turns : 0) + 1 });
      }
      for (const finding of escalations) {
        const key = `${target.project_id}:${finding.condition}`;
        const prior = snapshots.get(key)!;
        snapshots.set(key, { ...prior, escalated: true });
        const director = store.prepare(`SELECT a.thread_id AS thread_id FROM role_generation_heads h JOIN role_generations g ON g.project_id=h.project_id AND g.role_id=h.role_id AND g.generation=h.current_generation JOIN execution_attempts a ON a.project_id=g.project_id AND a.execution_attempt_id=g.holder_execution_attempt_id WHERE h.project_id=? AND h.role_id='director'`).get(target.project_id) as { thread_id: string } | undefined;
        if (director) {
          try {
            await bb.sdk.threads.send({ threadId: director.thread_id, mode: "auto", input: [{ type: "text", text: `Companion watcher escalation: ${finding.text}; unchanged after a wake and full turn.`, mentions: [] }] });
          } catch (error) {
            bb.log.warn(`companion-watcher coverage=blind event=thread.idle reason=${coverageReason("wake", error)}`);
            return;
          }
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
  });
}
