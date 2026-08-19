import type { BbPluginApi } from "@bb/plugin-sdk";
import { DIRECTOR_SEAT_ROLE_REQUIREMENT_ID, type SqliteDatabase } from "./foundation.js";
import { listAllProjectThreads } from "./worktree-cleanup.js";

export const DEFAULT_ARCHIVE_SWEEP_IDLE_HOURS = 24;
const THREAD_LIST_LIMIT = 1000;
export const ARCHIVE_SWEEP_GUARD = "thread-archive-sweep";

export type ArchiveSweepRefusalAggregate = {
  guard: typeof ARCHIVE_SWEEP_GUARD;
  reason: string;
  occurrencesSinceReload: number;
  cyclesSinceReload: number;
  projectsSinceReload: number;
  sinceReloadAtMs: number;
};

type ArchiveSweepRefusalState = ArchiveSweepRefusalAggregate & {
  lastCycle: number;
  projectIds: Set<string>;
};

export function createArchiveSweepRefusalCounter(sinceReloadAtMs = Date.now()) {
  let cycle = 0;
  const states = new Map<string, ArchiveSweepRefusalState>();
  return {
    beginCycle(): void {
      cycle += 1;
    },
    observe(reason: string, projectId: string | null): ArchiveSweepRefusalAggregate {
      if (cycle === 0) throw new Error("archive refusal counter cycle has not started");
      // This exact prose is the aggregation key, not control flow: rewording it
      // splits the signal, while normalization would merge distinct failures.
      // Project id is intentionally excluded from the key.
      const key = `${ARCHIVE_SWEEP_GUARD}\u0000${reason}`;
      const existing = states.get(key) ?? {
        guard: ARCHIVE_SWEEP_GUARD,
        reason,
        occurrencesSinceReload: 0,
        cyclesSinceReload: 0,
        projectsSinceReload: 0,
        sinceReloadAtMs,
        lastCycle: 0,
        projectIds: new Set<string>(),
      };
      existing.occurrencesSinceReload += 1;
      if (existing.lastCycle !== cycle) {
        existing.cyclesSinceReload += 1;
        existing.lastCycle = cycle;
      }
      if (projectId !== null && !existing.projectIds.has(projectId)) {
        existing.projectIds.add(projectId);
        existing.projectsSinceReload = existing.projectIds.size;
      }
      states.set(key, existing);
      return {
        guard: existing.guard,
        reason: existing.reason,
        occurrencesSinceReload: existing.occurrencesSinceReload,
        cyclesSinceReload: existing.cyclesSinceReload,
        projectsSinceReload: existing.projectsSinceReload,
        sinceReloadAtMs: existing.sinceReloadAtMs,
      };
    },
  };
}

export type ArchiveSweepResult = {
  outcome: "reported" | "applied" | "refused";
  archivableThreadIds: string[];
  archivedThreadIds: string[];
  protectedThreadCount: number;
  unresolvedThreadCount: number;
  message?: string;
};

type ArchiveSweepThread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];
const KNOWN_THREAD_STATUSES = new Set(["active", "error", "idle", "starting", "stopping"]);

function requiredThreadId(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${label} is unreadable`);
  return value;
}

function protectedThreadIds(db: SqliteDatabase, projectId: string): Set<string> {
  const attempts = db.prepare(
    "SELECT execution_attempt_id, thread_id FROM execution_attempts WHERE project_id = ? ORDER BY execution_attempt_id",
  ).all(projectId) as Array<{ execution_attempt_id?: unknown; thread_id?: unknown }>;
  if (attempts.length === 0) throw new Error("execution attempts are unavailable or empty");
  const ids = new Set<string>();
  for (const attempt of attempts) ids.add(requiredThreadId(attempt.thread_id, `execution attempt ${String(attempt.execution_attempt_id ?? "unknown")} thread binding`));

  const generations = db.prepare(
    `SELECT generations.role_id, generations.generation, generations.role_requirement_id,
            generations.holder_execution_attempt_id,
            attempts.execution_attempt_id, attempts.origin, attempts.thread_id
       FROM role_generations AS generations
       LEFT JOIN execution_attempts AS attempts
         ON attempts.project_id = generations.project_id
        AND attempts.execution_attempt_id = generations.holder_execution_attempt_id
      WHERE generations.project_id = ?
      ORDER BY generations.role_id, generations.generation`,
  ).all(projectId) as Array<{
    role_id?: unknown;
    generation?: unknown;
    role_requirement_id?: unknown;
    holder_execution_attempt_id?: unknown;
    execution_attempt_id?: unknown;
    origin?: unknown;
    thread_id?: unknown;
  }>;
  for (const generation of generations) {
    if (
      typeof generation.holder_execution_attempt_id !== "string" ||
      generation.execution_attempt_id !== generation.holder_execution_attempt_id ||
      generation.origin !== "role_holder"
    ) throw new Error(`role generation ${String(generation.role_id ?? "unknown")} holder binding is unreadable`);
    const isDirectorExemption = generation.role_requirement_id === DIRECTOR_SEAT_ROLE_REQUIREMENT_ID && generation.generation === 1;
    const label = isDirectorExemption
      ? "director first-generation holder"
      : `role generation ${String(generation.role_id ?? "unknown")} holder`;
    ids.add(requiredThreadId(generation.thread_id, label));
  }

  const currentSeats = db.prepare(
    `SELECT heads.role_id, heads.current_generation, generations.status,
            generations.holder_execution_attempt_id,
            attempts.execution_attempt_id, attempts.origin, attempts.thread_id
       FROM role_generation_heads AS heads
       LEFT JOIN role_generations AS generations
         ON generations.project_id = heads.project_id
        AND generations.role_id = heads.role_id
        AND generations.generation = heads.current_generation
       LEFT JOIN execution_attempts AS attempts
         ON attempts.project_id = generations.project_id
        AND attempts.execution_attempt_id = generations.holder_execution_attempt_id
      WHERE heads.project_id = ?
      ORDER BY heads.role_id`,
  ).all(projectId) as Array<{
    role_id?: unknown;
    current_generation?: unknown;
    status?: unknown;
    holder_execution_attempt_id?: unknown;
    execution_attempt_id?: unknown;
    origin?: unknown;
    thread_id?: unknown;
  }>;
  for (const seat of currentSeats) {
    if (
      seat.status !== "active" ||
      typeof seat.holder_execution_attempt_id !== "string" ||
      seat.execution_attempt_id !== seat.holder_execution_attempt_id ||
      seat.origin !== "role_holder"
    ) throw new Error(`current role seat ${String(seat.role_id ?? "unknown")} is unreadable`);
    ids.add(requiredThreadId(seat.thread_id, `current role seat ${String(seat.role_id ?? "unknown")} thread`));
  }
  return ids;
}

function idleHours(): number {
  const configured = Number(process.env.BB_COLLAB_ARCHIVE_IDLE_H);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ARCHIVE_SWEEP_IDLE_HOURS;
}

async function listProjectThreads(
  bb: Pick<BbPluginApi, "sdk">,
  projectId: string,
  archived: boolean,
): Promise<ArchiveSweepThread[]> {
  return listAllProjectThreads(
    (request) => bb.sdk.threads.list({ ...request, archived }),
    projectId,
    THREAD_LIST_LIMIT,
  );
}

function validateThreadInventory(
  projectId: string,
  unarchived: ArchiveSweepThread[],
  archived: ArchiveSweepThread[],
): void {
  const all = new Map<string, ArchiveSweepThread>();
  for (const [threads, expectArchived] of [[unarchived, false], [archived, true]] as const) {
    for (const thread of threads) {
      const id = requiredThreadId(thread.id, "thread inventory id");
      if (thread.projectId !== projectId) throw new Error(`thread ${id} belongs to another project`);
      const archiveStateKnown = expectArchived
        ? typeof thread.archivedAt === "number" && Number.isFinite(thread.archivedAt)
        : thread.archivedAt === null;
      if (!archiveStateKnown) throw new Error(`thread ${id} archive state is unreadable`);
      if (all.has(id)) throw new Error(`thread ${id} appears more than once in inventory`);
      all.set(id, thread);
    }
  }
  for (const thread of unarchived) {
    const threadId = requiredThreadId(thread.id, "thread inventory id");
    for (const [relation, relatedId] of [["parent", thread.parentThreadId], ["source", thread.sourceThreadId]] as const) {
      if (relatedId === null) continue;
      if (typeof relatedId !== "string" || relatedId === "" || !all.has(relatedId)) {
        throw new Error(`thread ${threadId} ${relation} relationship is unresolved`);
      }
    }
  }
}

async function threadPullRequestState(
  bb: Pick<BbPluginApi, "sdk">,
  thread: ArchiveSweepThread,
): Promise<"absent" | "protected" | "unknown"> {
  if (thread.environmentId === null) return "absent";
  if (typeof thread.environmentId !== "string" || thread.environmentId === "") return "unknown";
  try {
    const result = await bb.sdk.environments.pullRequest({ environmentId: thread.environmentId });
    if (result.outcome === "absent") return "absent";
    if (result.outcome === "unavailable") return "unknown";
    if (result.outcome === "available") {
      if (result.pullRequest.state === "open" || result.pullRequest.state === "draft") return "protected";
      if (result.pullRequest.state === "closed" || result.pullRequest.state === "merged") return "absent";
    }
  } catch {
    // A dangling environment is a per-thread unknown; it must not abort other roots.
  }
  return "unknown";
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
  if (!db) return { outcome: "refused", archivableThreadIds: [], archivedThreadIds: [], protectedThreadCount: 0, unresolvedThreadCount: 0, message: "canonical store unavailable" };
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
            unresolvedThreadCount: freshReport.unresolvedThreadCount,
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
        unresolvedThreadCount: report.unresolvedThreadCount,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  try {
    const protectedIds = protectedThreadIds(db, projectId);
    const [threads, archivedThreads] = await Promise.all([
      listProjectThreads(bb, projectId, false),
      listProjectThreads(bb, projectId, true),
    ]);
    validateThreadInventory(projectId, threads, archivedThreads);
    const minimumUpdatedAt = now - idleHours() * 60 * 60 * 1000;
    const blockedIds = new Set<string>();
    let unresolvedThreadCount = 0;
    for (const thread of threads) {
      const threadId = requiredThreadId(thread.id, "thread inventory id");
      if (!KNOWN_THREAD_STATUSES.has(thread.status)) {
        blockedIds.add(threadId);
        unresolvedThreadCount += 1;
      } else if (
        thread.status === "active" ||
        thread.status === "starting" ||
        thread.archivedAt !== null ||
        thread.deletedAt !== null ||
        !Number.isFinite(thread.updatedAt) ||
        thread.updatedAt > minimumUpdatedAt ||
        protectedIds.has(threadId)
      ) {
        blockedIds.add(threadId);
        if (!Number.isFinite(thread.updatedAt)) unresolvedThreadCount += 1;
      }
      const pullRequestState = await threadPullRequestState(bb, thread);
      if (pullRequestState !== "absent") {
        blockedIds.add(threadId);
        if (pullRequestState === "unknown") unresolvedThreadCount += 1;
      }
    }
    const protectedAncestors = ancestorIds(threads, blockedIds);
    const eligibleIds = new Set(threads.filter((thread) => !blockedIds.has(thread.id) && !protectedAncestors.has(thread.id)).map((thread) => thread.id));
    const rootEligibleIds = topLevelIds(threads, eligibleIds);
    const archivableThreadIds = threads.filter((thread) => rootEligibleIds.has(thread.id)).map((thread) => thread.id);
    return { outcome: "reported", archivableThreadIds, archivedThreadIds: [], protectedThreadCount: protectedIds.size, unresolvedThreadCount };
  } catch (error) {
    return {
      outcome: "refused",
      archivableThreadIds: [],
      archivedThreadIds: [],
      protectedThreadCount: 0,
      unresolvedThreadCount: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
