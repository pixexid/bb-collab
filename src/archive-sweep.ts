import type { BbPluginApi } from "@bb/plugin-sdk";
import { DIRECTOR_SEAT_FIRST_GENERATION_EXEMPTION, type SqliteDatabase } from "./foundation.js";

export const DEFAULT_ARCHIVE_SWEEP_IDLE_HOURS = 24;
const THREAD_LIST_LIMIT = 1000;

// Remove only when GH-104 records every live seat through execution_attempts.
// A missing project entry is missing live-seat evidence and refuses the sweep.
const LIVE_SEAT_ALLOWLIST = new Map([["proj_a8zzfsx36j", new Set(["thr_b94i3csnme", "thr_bpzjyqg7ys"])]]);

export type ArchiveSweepResult = {
  outcome: "reported" | "applied" | "refused";
  archivableThreadIds: string[];
  archivedThreadIds: string[];
  protectedThreadCount: number;
  message?: string;
};

function protectedThreadIds(db: SqliteDatabase, projectId: string): Set<string> {
  const attemptCount = (db.prepare("SELECT COUNT(*) AS count FROM execution_attempts WHERE project_id = ?").get(projectId) as { count?: unknown } | undefined)?.count;
  if (!Number.isInteger(attemptCount) || attemptCount === 0) throw new Error("execution attempts are unavailable or empty");
  const rows = db.prepare(
    `SELECT thread_id FROM execution_attempts WHERE project_id = ? AND thread_id IS NOT NULL
     UNION
     SELECT attempts.thread_id
       FROM role_generations AS generations
       JOIN execution_attempts AS attempts
         ON attempts.project_id = generations.project_id
        AND attempts.execution_attempt_id = generations.holder_execution_attempt_id
      WHERE generations.project_id = ? AND attempts.thread_id IS NOT NULL`,
  ).all(projectId, projectId) as Array<{ thread_id?: unknown }>;
  const liveSeats = LIVE_SEAT_ALLOWLIST.get(projectId);
  if (!liveSeats) throw new Error("live-seat allowlist is unavailable for project");
  const ids = new Set<string>(liveSeats);
  ids.add(DIRECTOR_SEAT_FIRST_GENERATION_EXEMPTION.holderThreadId);
  for (const row of rows) {
    if (typeof row.thread_id !== "string" || row.thread_id === "") throw new Error("protected thread id is invalid");
    ids.add(row.thread_id);
  }
  return ids;
}

function idleHours(): number {
  const configured = Number(process.env.BB_COLLAB_ARCHIVE_IDLE_H);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ARCHIVE_SWEEP_IDLE_HOURS;
}

function ancestorIds(threads: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>, threadIds: Set<string>): Set<string> {
  const parentIdsByThreadId = new Map(threads.map((thread) => [thread.id, [thread.parentThreadId, thread.sourceThreadId].filter((id): id is string => id !== null)]));
  const ancestors = new Set<string>();
  const visit = (threadId: string, path: Set<string>): void => {
    for (const parentThreadId of parentIdsByThreadId.get(threadId) ?? []) {
      if (path.has(parentThreadId)) throw new Error("thread ancestry cycle");
      ancestors.add(parentThreadId);
      visit(parentThreadId, new Set(path).add(parentThreadId));
    }
  };
  for (const thread of threads) {
    if (!threadIds.has(thread.id)) continue;
    visit(thread.id, new Set([thread.id]));
  }
  return ancestors;
}

function topLevelIds(threads: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>, eligibleIds: Set<string>): Set<string> {
  const parentIdsByThreadId = new Map(threads.map((thread) => [thread.id, [thread.parentThreadId, thread.sourceThreadId].filter((id): id is string => id !== null)]));
  const roots = new Set<string>();
  const hasEligibleAncestor = (threadId: string, path: Set<string>): boolean => {
    for (const parentThreadId of parentIdsByThreadId.get(threadId) ?? []) {
      if (path.has(parentThreadId)) throw new Error("thread ancestry cycle");
      if (eligibleIds.has(parentThreadId) || hasEligibleAncestor(parentThreadId, new Set(path).add(parentThreadId))) return true;
    }
    return false;
  };
  for (const thread of threads) {
    if (!eligibleIds.has(thread.id)) continue;
    if (!hasEligibleAncestor(thread.id, new Set([thread.id]))) roots.add(thread.id);
  }
  return roots;
}

export async function runArchiveSweep(
  bb: Pick<BbPluginApi, "sdk">,
  db: SqliteDatabase | null,
  projectId: string,
  apply = false,
  now = Date.now(),
): Promise<ArchiveSweepResult> {
  if (!db) return { outcome: "refused", archivableThreadIds: [], archivedThreadIds: [], protectedThreadCount: 0, message: "canonical store unavailable" };
  if (apply) {
    const report = await runArchiveSweep(bb, db, projectId, false, now);
    if (report.outcome !== "reported") return report;
    const archivedThreadIds = new Set<string>();
    try {
      for (const threadId of report.archivableThreadIds) {
        const freshReport = await runArchiveSweep(bb, db, projectId, false, now);
        if (freshReport.outcome !== "reported" || !freshReport.archivableThreadIds.includes(threadId)) {
          return {
            outcome: "refused",
            archivableThreadIds: [],
            archivedThreadIds: [...archivedThreadIds],
            protectedThreadCount: freshReport.protectedThreadCount,
            message: `archive candidate changed before apply: ${threadId}`,
          };
        }
        const archived = await bb.sdk.threads.archive({ threadId });
        for (const archivedThreadId of archived.archivedThreadIds) archivedThreadIds.add(archivedThreadId);
      }
      return { ...report, outcome: "applied", archivedThreadIds: [...archivedThreadIds] };
    } catch (error) {
      return {
        outcome: "refused",
        archivableThreadIds: [],
        archivedThreadIds: [...archivedThreadIds],
        protectedThreadCount: report.protectedThreadCount,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  try {
    const protectedIds = protectedThreadIds(db, projectId);
    const threads = await bb.sdk.threads.list({ projectId, archived: false, includeHidden: true, limit: THREAD_LIST_LIMIT });
    if (threads.length >= THREAD_LIST_LIMIT) throw new Error("thread inventory reached the bounded read limit");
    const minimumUpdatedAt = now - idleHours() * 60 * 60 * 1000;
    const blockedIds = new Set(threads.filter((thread) =>
      ["active", "starting"].includes(thread.status) ||
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      thread.updatedAt > minimumUpdatedAt ||
      protectedIds.has(thread.id),
    ).map((thread) => thread.id));
    for (const thread of threads) {
      if (thread.environmentId === null) continue;
      const pullRequest = await bb.sdk.environments.pullRequest({ environmentId: thread.environmentId });
      if (pullRequest.outcome === "unavailable") throw new Error(`pull request lookup unavailable for ${thread.id}`);
      if (pullRequest.outcome === "available" && ["open", "draft"].includes(pullRequest.pullRequest.state)) blockedIds.add(thread.id);
    }
    const protectedAncestors = ancestorIds(threads, blockedIds);
    const eligibleIds = new Set(threads.filter((thread) => !blockedIds.has(thread.id) && !protectedAncestors.has(thread.id)).map((thread) => thread.id));
    const rootEligibleIds = topLevelIds(threads, eligibleIds);
    const archivableThreadIds = threads.filter((thread) => rootEligibleIds.has(thread.id)).map((thread) => thread.id);
    return { outcome: "reported", archivableThreadIds, archivedThreadIds: [], protectedThreadCount: protectedIds.size };
  } catch (error) {
    return {
      outcome: "refused",
      archivableThreadIds: [],
      archivedThreadIds: [],
      protectedThreadCount: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
