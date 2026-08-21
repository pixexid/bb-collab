import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

export type WorktreePopulation = "scratch" | "managed" | "candidate" | "unknown";

export type WorktreeEntry = {
  path: string;
  branch: string | null;
  head: string | null;
  population?: WorktreePopulation;
  threadId?: string | null;
};

export type WorktreeDecision = {
  path: string;
  threadId?: string | null;
  population: WorktreePopulation;
  action: "remove" | "refuse";
  reason: string;
};

export type WorktreeCleanupReport = {
  outcome: "reported" | "refused";
  wouldRemove: WorktreeDecision[];
  removableCandidateCount: number;
  refused: WorktreeDecision[];
  environmentRecordsReleased: false;
  attestation: { coverage: "known" } | { coverage: "blind"; reason: string };
};

type ExecutedProfileRead = {
  outcome?: string;
  environmentDependent?: boolean;
  reason?: string;
  turns?: ReadonlyArray<{ phase?: string; environmentDependent?: boolean; reason?: string }>;
};

export function cleanupAttestationFromProfile(profile: ExecutedProfileRead):
  { coverage: "known" } | { coverage: "blind"; reason: string } {
  const environmentDependent = profile.environmentDependent ?? profile.turns?.some((turn) => turn.environmentDependent) ?? false;
  if (environmentDependent) {
    if (profile.outcome === "unknown") return { coverage: "blind", reason: "expiry is not distinguishable from the executed-profile reader today; pending upstream get-bb/bb#2134" };
    return { coverage: "known" };
  }
  return { coverage: "known" };
}


export type WorktreeCleanupOptions = {
  liveThreadIds: ReadonlySet<string>;
  liveWorktreeThreadIds?: ReadonlyMap<string, ReadonlySet<string>>;
  home?: string;
  originMain?: string;
  status?: (path: string) => string;
  reachable?: (path: string, head: string) => boolean;
  environmentInventoryComplete?: boolean;
  /** False when the plugin source could not be resolved; no removal is safe then. */
  pluginSourceResolved?: boolean;
  /** Environment-level claims, including environments not attached to a thread. */
  protectedEnvironmentPaths?: ReadonlySet<string>;
  createdAt?: (path: string) => number | null;
  now?: number;
  quietFloorMs?: number;
  attestation?: { coverage: "known" } | { coverage: "blind"; reason: string };
};

const threadPattern = /thr_[a-z0-9]+/u;

// A chosen safety margin, not a measurement. The floor guards only the gap between a PR
// merging and the reviewer closing their checkout: a review still in flight is already
// protected by reachability, because an unmerged head is not an ancestor of origin/main,
// and a reviewer who wrote anything is already protected by the uncommitted-changes
// refusal. Cold reviews observed in this repo complete in well under an hour, so 24h is
// roughly a 24x margin on the longest window actually seen. It sits well above that
// window rather than close to it because the costs are asymmetric -- keeping a worktree
// an extra day costs disk, removing one a reviewer still holds costs their work.
export const defaultQuietFloorMs = 24 * 60 * 60 * 1000;

const reflogCreation = /^\S+ \S+ .* (\d+) [-+]\d{4}(?:\t|$)/u;

export function worktreeCreatedAt(path: string): number | null {
  try {
    const dotGit = resolve(path, ".git");
    const adminDir = statSync(dotGit).isDirectory()
      ? dotGit
      : resolve(path, readFileSync(dotGit, "utf8").match(/^gitdir: (.+)$/mu)?.[1] ?? "");
    const seconds = readFileSync(resolve(adminDir, "logs/HEAD"), "utf8").split("\n")[0].match(reflogCreation)?.[1];
    return seconds === undefined ? null : Number(seconds) * 1000;
  } catch {
    return null;
  }
}

export function canonicalWorktreePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function classifyWorktree(path: string, home = process.env.HOME ?? ""): WorktreePopulation {
  const target = canonicalWorktreePath(path);
  const managed = resolve(home, ".bb/worktrees");
  if (target === managed || target.startsWith(`${managed}/`)) return "managed";
  const candidates = resolve(home, ".bb/thread-storage");
  if (target === candidates || target.startsWith(`${candidates}/`)) return "candidate";
  const tmp = ["/tmp", "/private/tmp"].map((root) => resolve(root));
  if (tmp.some((root) => target === root || target.startsWith(`${root}/`))) return "scratch";
  return "unknown";
}

export function threadIdFromBranch(branch: string | null): string | null {
  return branch?.match(threadPattern)?.[0] ?? null;
}

export function planWorktreeCleanup(entries: WorktreeEntry[], options: WorktreeCleanupOptions): WorktreeDecision[] {
  const decisions: WorktreeDecision[] = [];
  for (const entry of entries) {
    const population = entry.population ?? classifyWorktree(entry.path, options.home);
    const threadId = entry.threadId === undefined ? threadIdFromBranch(entry.branch) : entry.threadId;
    const entryPath = canonicalWorktreePath(entry.path);
    if (options.pluginSourceResolved === false) {
      decisions.push({ path: entry.path, population, action: "refuse", reason: "plugin source environment is unresolved" });
      continue;
    }
    if ([...(options.protectedEnvironmentPaths ?? [])].some((protectedPath) => {
      const normalized = canonicalWorktreePath(protectedPath);
      return normalized === entryPath || normalized.startsWith(`${entryPath}/`);
    })) {
      decisions.push({ path: entry.path, population, action: "refuse", reason: "plugin source environment is protected" });
      continue;
    }
    if (population === "candidate") {
      decisions.push({ path: entry.path, population, action: "refuse", reason: "per-thread candidate checkout is protected" });
      continue;
    }
    const associatedLiveThreads = options.liveWorktreeThreadIds?.get(canonicalWorktreePath(entry.path));
    let unclaimedAgeMs: number | null = null;
    if ((threadId && options.liveThreadIds.has(threadId)) || (associatedLiveThreads && associatedLiveThreads.size > 0)) {
      const owners = threadId && options.liveThreadIds.has(threadId) ? [threadId] : [...associatedLiveThreads!];
      decisions.push({ path: entry.path, population, action: "refuse", reason: `live thread ${owners.join(",")}` });
      continue;
    }
    if (population === "managed") {
      decisions.push({ path: entry.path, population, action: "refuse", reason: "BB environment record cannot be released by the available SDK" });
      continue;
    }
    if (population === "unknown") {
      decisions.push({ path: entry.path, population, action: "refuse", reason: "worktree is outside the owned scratch/managed populations" });
      continue;
    }
    if (!entry.head) {
      decisions.push({ path: entry.path, population, action: "refuse", reason: "worktree HEAD is unavailable" });
      continue;
    }
    // A detached scratch checkout records no thread id anywhere -- not in the path, the
    // gitdir, or the reflog -- so ownership can only be resolved affirmatively: the live
    // environment inventory was enumerated in full and no environment claims this path.
    // GH-302 ruled that absence is report-only evidence: an apply mode must require a positive
    // bb provenance marker instead. Ruling, measurement, and cost are in that issue's close comment.
    if (threadId === null) {
      if (entry.branch !== null) {
        decisions.push({ path: entry.path, population, action: "refuse", reason: `thread ownership unresolved for worktree on branch ${entry.branch}` });
        continue;
      }
      if (options.environmentInventoryComplete !== true) {
        decisions.push({ path: entry.path, population, action: "refuse", reason: "bb environment inventory is incomplete; detached ownership unresolved" });
        continue;
      }
      const createdAt = options.createdAt?.(entry.path) ?? null;
      if (createdAt === null) {
        decisions.push({ path: entry.path, population, action: "refuse", reason: "worktree creation record is unavailable; detached ownership unresolved" });
        continue;
      }
      const quietFloorMs = options.quietFloorMs ?? defaultQuietFloorMs;
      const ageMs = (options.now ?? Date.now()) - createdAt;
      if (ageMs < quietFloorMs) {
        decisions.push({ path: entry.path, population, action: "refuse", reason: `created ${(ageMs / 3_600_000).toFixed(1)}h ago, inside the ${(quietFloorMs / 3_600_000).toFixed(1)}h quiet floor` });
        continue;
      }
      unclaimedAgeMs = ageMs;
    }
    // An absent probe and a probe reporting clean are different facts that "" cannot tell
    // apart, so the absence is resolved here rather than folded into the emptiness test below.
    if (options.status === undefined) {
      decisions.push({ path: entry.path, population, action: "refuse", reason: "no git status probe supplied; cleanliness unresolved" });
      continue;
    }
    let status = "";
    try {
      status = options.status(entry.path);
    } catch (error) {
      decisions.push({ path: entry.path, population, action: "refuse", reason: `git status failed for ${entry.path}: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    if (status !== "") {
      decisions.push({ path: entry.path, population, action: "refuse", reason: "uncommitted changes" });
      continue;
    }
    let reachable = false;
    try {
      reachable = Boolean(options.originMain && options.reachable?.(entry.path, entry.head));
    } catch (error) {
      decisions.push({ path: entry.path, population, action: "refuse", reason: `reachability check failed for ${entry.path}: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    if (!reachable) {
      decisions.push({ path: entry.path, population, action: "refuse", reason: "commits are not reachable from origin/main" });
      continue;
    }
    const unclaimed = unclaimedAgeMs === null ? "" : `, unclaimed by any live bb environment and created ${(unclaimedAgeMs / 3_600_000).toFixed(1)}h ago`;
    decisions.push({ path: entry.path, population, action: "remove", reason: `clean and fully reachable from origin/main${unclaimed}`, ...(threadId ? { threadId } : {}) });
  }
  return decisions;
}

export function runWorktreeCleanup(entries: WorktreeEntry[], options: WorktreeCleanupOptions): WorktreeCleanupReport {
  const decisions = planWorktreeCleanup(entries, options);
  const wouldRemove = decisions.filter((decision) => decision.action === "remove");
  const refused = decisions.filter((decision) => decision.action === "refuse");
  const attestation = options.attestation ?? { coverage: "known" as const };
  return { outcome: refused.length > 0 ? "refused" : "reported", wouldRemove, removableCandidateCount: wouldRemove.length, refused, environmentRecordsReleased: false, attestation };
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } }).trim();
}

export function listGitWorktrees(repoRoot: string): WorktreeEntry[] {
  const lines = git(["worktree", "list", "--porcelain"], repoRoot).split("\n");
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: canonicalWorktreePath(line.slice("worktree ".length)), branch: null, head: null };
    } else if (current && line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    else if (current && line.startsWith("branch ")) current.branch = line.slice("branch ".length).replace(/^refs\/heads\//u, "");
  }
  if (current) entries.push(current);
  return entries;
}

export function cleanupGitWorktrees(
  repoRoot: string,
  liveThreadIds: ReadonlySet<string>,
  liveWorktreeThreadIds: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  environmentInventoryComplete = false,
  protectedEnvironmentPaths: ReadonlySet<string> = new Set(),
  pluginSourceResolved = true,
  attestation?: WorktreeCleanupOptions["attestation"],
  entries?: WorktreeEntry[],
): WorktreeCleanupReport {
  const originMain = git(["rev-parse", "refs/remotes/origin/main"], repoRoot);
  const status = (path: string) => git(["status", "--porcelain", "--untracked-files=all"], path);
  return runWorktreeCleanup(entries ?? listGitWorktrees(repoRoot), {
    liveThreadIds,
    liveWorktreeThreadIds,
    environmentInventoryComplete,
    protectedEnvironmentPaths,
    pluginSourceResolved,
    attestation,
    createdAt: worktreeCreatedAt,
    originMain,
    status,
    reachable: (path, head) => {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", head, originMain], { cwd: path, stdio: "pipe", env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } });
        return true;
      } catch {
        return false;
      }
    },
  });
}

export async function listAllProjectThreads<T extends { id: string }>(
  list: (args: { projectId: string; archived: false; includeHidden: true; limit: number; offset: number }) => Promise<T[]>,
  projectId: string,
  pageSize = 1000,
): Promise<T[]> {
  const threads: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await list({ projectId, archived: false, includeHidden: true, limit: pageSize, offset });
    threads.push(...page);
    if (page.length < pageSize) return threads;
    if (offset >= 100_000) throw new Error("thread inventory exceeded bounded pagination");
  }
}
