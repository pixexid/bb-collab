import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

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
  population: WorktreePopulation;
  action: "remove" | "refuse";
  reason: string;
};

export type WorktreeCleanupReport = {
  outcome: "reported" | "applied" | "refused";
  removed: string[];
  refused: WorktreeDecision[];
  environmentRecordsReleased: false;
};

export type WorktreeCleanupOptions = {
  liveThreadIds: ReadonlySet<string>;
  apply?: boolean;
  home?: string;
  originMain?: string;
  status?: (path: string) => string;
  reachable?: (path: string, head: string) => boolean;
  remove?: (path: string) => void;
};

const threadPattern = /thr_[a-z0-9]+/u;

export function classifyWorktree(path: string, home = process.env.HOME ?? ""): WorktreePopulation {
  const target = resolve(path);
  const tmp = ["/tmp", "/private/tmp"].map((root) => resolve(root));
  if (tmp.some((root) => target === root || target.startsWith(`${root}/`))) return "scratch";
  const managed = resolve(home, ".bb/worktrees");
  if (target === managed || target.startsWith(`${managed}/`)) return "managed";
  const candidates = resolve(home, ".bb/thread-storage");
  if (target === candidates || target.startsWith(`${candidates}/`)) return "candidate";
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
    if (population === "candidate") {
      decisions.push({ path: entry.path, population, action: "refuse", reason: "per-thread candidate checkout is protected" });
      continue;
    }
    if (threadId && options.liveThreadIds.has(threadId)) {
      decisions.push({ path: entry.path, population, action: "refuse", reason: `live thread ${threadId}` });
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
    if ((options.status?.(entry.path) ?? "") !== "") {
      decisions.push({ path: entry.path, population, action: "refuse", reason: "uncommitted changes" });
      continue;
    }
    if (!options.originMain || !(options.reachable?.(entry.path, entry.head) ?? false)) {
      decisions.push({ path: entry.path, population, action: "refuse", reason: "commits are not reachable from origin/main" });
      continue;
    }
    decisions.push({ path: entry.path, population, action: "remove", reason: "clean and fully reachable from origin/main" });
  }
  return decisions;
}

export function runWorktreeCleanup(entries: WorktreeEntry[], options: WorktreeCleanupOptions): WorktreeCleanupReport {
  const decisions = planWorktreeCleanup(entries, options);
  const removed: string[] = [];
  const refused = decisions.filter((decision) => decision.action === "refuse");
  if (options.apply) {
    for (const decision of decisions.filter((item) => item.action === "remove")) {
      try {
        options.remove?.(decision.path);
        removed.push(decision.path);
      } catch (error) {
        refused.push({ ...decision, action: "refuse", reason: `git worktree remove failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }
  return { outcome: refused.length > 0 ? "refused" : options.apply ? "applied" : "reported", removed, refused, environmentRecordsReleased: false };
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
      current = { path: line.slice("worktree ".length), branch: null, head: null };
    } else if (current && line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    else if (current && line.startsWith("branch ")) current.branch = line.slice("branch ".length).replace(/^refs\/heads\//u, "");
  }
  if (current) entries.push(current);
  return entries;
}

export function cleanupGitWorktrees(repoRoot: string, liveThreadIds: ReadonlySet<string>, apply = false): WorktreeCleanupReport {
  const originMain = git(["rev-parse", "refs/remotes/origin/main"], repoRoot);
  const status = (path: string) => git(["status", "--porcelain", "--untracked-files=all"], path);
  const reachable = (path: string, head: string) => git(["rev-list", "--not", originMain, head], path) === "";
  return runWorktreeCleanup(listGitWorktrees(repoRoot), {
    liveThreadIds,
    apply,
    originMain,
    status,
    reachable,
    remove: (path) => {
      if (!existsSync(path)) return;
      if (!isAbsolute(path)) throw new Error("worktree path is not absolute");
      execFileSync("git", ["worktree", "remove", path], { cwd: repoRoot, stdio: "pipe" });
    },
  });
}
