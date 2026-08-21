import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorktreeCleanupOptions } from "../src/worktree-cleanup.js";
import {
  canonicalWorktreePath,
  cleanupAttestationFromProfile,
  cleanupCandidateThreadIds,
  classifyWorktree,
  cleanupGitWorktrees,
  defaultQuietFloorMs,
  listAllProjectThreads,
  listGitWorktrees,
  planWorktreeCleanup,
  runWorktreeCleanup,
  worktreeCreatedAt,
  withCleanupAttestationSubjects,
} from "../src/worktree-cleanup.js";

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

function fixture() {
  const root = mkdtempSync("/tmp/bb-worktree-cleanup-");
  roots.push(root);
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "test");
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, "add", "base.txt");
  git(root, "commit", "--quiet", "-m", "base");
  git(root, "branch", "-M", "main");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  const paths = ["live", "orphan", "dirty"].map((name) => join(root, name));
  for (const path of paths) git(root, "worktree", "add", "--quiet", "--detach", path, "HEAD");
  writeFileSync(join(paths[2], "dirty.txt"), "dirty\n");
  return { root, paths };
}

// Mirrors cleanupGitWorktrees' git wiring while leaving the clock and the inventory
// verdict injectable, so each refusal can be exercised in isolation.
function report(root: string, live: Set<string>, ownership: Map<string, Set<string>>, overrides: Partial<WorktreeCleanupOptions> = {}) {
  const originMain = git(root, "rev-parse", "refs/remotes/origin/main");
  return runWorktreeCleanup(listGitWorktrees(root), {
    liveThreadIds: live,
    liveWorktreeThreadIds: ownership,
    originMain,
    status: (path) => git(path, "status", "--porcelain", "--untracked-files=all"),
    reachable: (path, head) => {
      try {
        git(path, "merge-base", "--is-ancestor", head, originMain);
        return true;
      } catch {
        return false;
      }
    },
    environmentInventoryComplete: true,
    createdAt: worktreeCreatedAt,
    now: Date.now() + defaultQuietFloorMs,
    ...overrides,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("worktree cleanup", () => {
  it("protects managed and candidate roots when HOME itself is under /tmp", () => {
    const managed = classifyWorktree("/tmp/home/.bb/worktrees/orphan", "/tmp/home");
    const candidate = classifyWorktree("/tmp/home/.bb/thread-storage/candidate", "/tmp/home");
    console.log(`overlap classification: ${JSON.stringify({ managed, candidate, preFixManaged: "scratch", preFixCandidate: "scratch" })}`);
    expect(managed).toBe("managed");
    expect(candidate).toBe("candidate");
  });

  it("reads the creation timestamp git wrote into the detached worktree's own reflog", () => {
    const { paths } = fixture();
    const createdAt = worktreeCreatedAt(paths[1]);
    expect(createdAt).not.toBeNull();
    expect(Math.abs(Date.now() - createdAt!)).toBeLessThan(60_000);
  });

  // The two optional probes had opposite fail-safe polarity: an omitted reachable gives
  // Boolean(undefined) = false = refuse, while an omitted status gave "" = clean = allow.
  // "" is a legitimate clean result from a real porcelain call, so absence is what moved.
  it("refuses a clean reachable orphan when no status probe is supplied", () => {
    const { root, paths } = fixture();
    const result = report(root, new Set(), new Map(), { status: undefined });
    expect(result.wouldRemove).toEqual([]);
    expect(result.refused).toContainEqual(expect.objectContaining({
      path: canonicalWorktreePath(paths[1]),
      reason: "no git status probe supplied; cleanliness unresolved",
    }));
  });

  it("protects a plugin subdirectory by its owning worktree", () => {
    const { root, paths } = fixture();
    mkdirSync(join(paths[1], "packages/plugin"), { recursive: true });
    const result = report(root, new Set(), new Map(), { protectedEnvironmentPaths: new Set([join(paths[1], "packages/plugin")]) });
    expect(result.wouldRemove.map(({ path }) => path)).not.toContain(canonicalWorktreePath(paths[1]));
    expect(result.refused).toContainEqual(expect.objectContaining({ path: canonicalWorktreePath(paths[1]), reason: "plugin source environment is protected" }));
  });

  it("refuses every removal class when the plugin source cannot be resolved", () => {
    const { root, paths } = fixture();
    const result = planWorktreeCleanup([
      { path: paths[1], branch: "feature/thr_stale", head: git(paths[1], "rev-parse", "HEAD") },
    ], {
      liveThreadIds: new Set(),
      pluginSourceResolved: false,
      status: () => "",
      originMain: git(root, "rev-parse", "refs/remotes/origin/main"),
      reachable: () => true,
    });
    expect(result).toEqual([{ path: resolve(paths[1]), population: "scratch", action: "refuse", reason: "plugin source environment is unresolved" }]);
  });

  it("protects a plugin source environment claim even without a thread owner", () => {
    const { root, paths } = fixture();
    const result = report(root, new Set(), new Map(), { protectedEnvironmentPaths: new Set([canonicalWorktreePath(paths[1])]) });
    expect(result.wouldRemove.map(({ path }) => path)).not.toContain(canonicalWorktreePath(paths[1]));
    expect(result.refused).toContainEqual(expect.objectContaining({ path: canonicalWorktreePath(paths[1]), reason: "plugin source environment is protected" }));
  });

  it("distinguishes safe, at-risk, and unreadable attestation evidence", () => {
    expect(cleanupAttestationFromProfile({ outcome: "unknown", environmentDependent: false })).toEqual({ coverage: "known" });
    expect(cleanupAttestationFromProfile({ outcome: "known", environmentDependent: true })).toEqual({
      coverage: "at-risk",
      reason: "environment reaping removes the path needed to correlate this attestation; preserve correlation or retain the environment",
    });
    expect(cleanupAttestationFromProfile({ outcome: "unknown", environmentDependent: true })).toEqual({
      coverage: "blind",
      reason: "expiry is not distinguishable from the executed-profile reader today; pending upstream get-bb/bb#2134",
    });
    expect(cleanupAttestationFromProfile({ outcome: "unknown", turns: [{ phase: "active", environmentDependent: true }] })).toMatchObject({ coverage: "blind" });
  });

  it("attests only removable thread-bearing worktrees", () => {
    expect([...cleanupCandidateThreadIds([
      { path: "live", threadId: "thr_live", population: "scratch", action: "refuse", reason: "live thread" },
      { path: "old", threadId: "thr_old", population: "scratch", action: "remove", reason: "clean" },
    ])]).toEqual(["thr_old"]);
  });

  it("names the environment and thread in at-risk attestation", () => {
    expect(withCleanupAttestationSubjects({ coverage: "at-risk", reason: "retain it" }, [{ path: "/tmp/env", threadId: "thr_dependent" }])).toEqual({
      coverage: "at-risk",
      reason: "retain it",
      affected: [{ path: "/tmp/env", threadId: "thr_dependent" }],
    });
  });

  it("reports removable candidates with at-risk expiry attestation", () => {
    const { root, paths } = fixture();
    const result = report(root, new Set(["thr_live"]), new Map([[canonicalWorktreePath(paths[0]), new Set(["thr_live"])] ]), {
      attestation: {
        coverage: "at-risk",
        reason: "environment reaping removes the path needed to correlate this attestation; preserve correlation or retain the environment",
        affected: [{ path: canonicalWorktreePath(paths[1]), threadId: "thr_old" }],
      },
    });
    expect(result.removableCandidateCount).toBe(1);
    expect(result.attestation).toEqual({
      coverage: "at-risk",
      reason: "environment reaping removes the path needed to correlate this attestation; preserve correlation or retain the environment",
      affected: [{ path: canonicalWorktreePath(paths[1]), threadId: "thr_old" }],
    });
    expect(result.environmentRecordsReleased).toBe(false);
    expect(result.wouldRemove.map(({ path }) => path)).toEqual([canonicalWorktreePath(paths[1])]);
  });

  it("uses the measured worktree snapshot for cleanup decisions", () => {
    const { root, paths } = fixture();
    const result = cleanupGitWorktrees(root, new Set(), new Map(), true, new Set(), true, {
      coverage: "known",
    }, []);
    expect(result.wouldRemove).toEqual([]);
    expect(result.refused).toEqual([]);
  });

  it("reports exactly the clean detached orphan and refuses live and dirty entries", () => {
    const { root, paths } = fixture();
    const ownership = new Map([[canonicalWorktreePath(paths[0]), new Set(["thr_live"])]]);
    const result = report(root, new Set(["thr_live"]), ownership);
    expect(result.wouldRemove.map(({ path }) => path)).toEqual([canonicalWorktreePath(paths[1])]);
    expect(result.refused).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: canonicalWorktreePath(paths[0]), reason: "live thread thr_live" }),
      expect.objectContaining({ path: canonicalWorktreePath(paths[2]), reason: "uncommitted changes" }),
    ]));
    console.log(`fixture discrimination: ${JSON.stringify({ wouldRemove: result.wouldRemove.map(({ path }) => path), refused: result.refused.map(({ path, reason }) => ({ path, reason })) })}`);
  });

  it("refuses the checked-out main worktree that carries no thread id", () => {
    const { root } = fixture();
    const result = report(root, new Set(), new Map());
    expect(result.wouldRemove.map(({ path }) => path)).not.toContain(canonicalWorktreePath(root));
    expect(result.refused).toContainEqual(expect.objectContaining({ path: canonicalWorktreePath(root), reason: "thread ownership unresolved for worktree on branch main" }));
  });

  it("refuses every detached worktree when the environment inventory is incomplete", () => {
    const { root, paths } = fixture();
    const result = report(root, new Set(), new Map(), { environmentInventoryComplete: false });
    expect(result.wouldRemove).toEqual([]);
    expect(result.refused).toContainEqual(expect.objectContaining({ path: canonicalWorktreePath(paths[1]), reason: "bb environment inventory is incomplete; detached ownership unresolved" }));
  });

  it("refuses a detached worktree created inside the quiet floor", () => {
    const { root, paths } = fixture();
    const result = report(root, new Set(), new Map(), { now: Date.now() });
    expect(result.wouldRemove).toEqual([]);
    expect(result.refused).toContainEqual(expect.objectContaining({ path: canonicalWorktreePath(paths[1]), reason: expect.stringContaining("quiet floor") }));
  });

  it("refuses a detached worktree whose creation record cannot be read", () => {
    const { root, paths } = fixture();
    const result = report(root, new Set(), new Map(), { createdAt: () => null });
    expect(result.wouldRemove).toEqual([]);
    expect(result.refused).toContainEqual(expect.objectContaining({ path: canonicalWorktreePath(paths[1]), reason: "worktree creation record is unavailable; detached ownership unresolved" }));
  });

  it("refuses a clean worktree one commit ahead of origin/main", () => {
    const { root, paths } = fixture();
    writeFileSync(join(paths[1], "ahead.txt"), "ahead\n");
    git(paths[1], "add", "ahead.txt");
    git(paths[1], "commit", "--quiet", "-m", "ahead");
    const result = report(root, new Set(), new Map());
    expect(result.wouldRemove.map(({ path }) => path)).not.toContain(canonicalWorktreePath(paths[1]));
    expect(result.refused).toContainEqual(expect.objectContaining({ path: canonicalWorktreePath(paths[1]), reason: "commits are not reachable from origin/main" }));
  });

  it("pages the complete live-thread inventory past page 1000", async () => {
    const pages: string[][] = [Array.from({ length: 1000 }, (_, index) => `thr_${index}`), ["thr_1000"]];
    const threads = await listAllProjectThreads(async ({ offset }) => pages[offset / 1000].map((id) => ({ id })), "project");
    expect(threads).toHaveLength(1001);
    const { root, paths } = fixture();
    const result = report(root, new Set(["thr_1000"]), new Map([[canonicalWorktreePath(paths[1]), new Set(["thr_1000"])]]));
    expect(result.wouldRemove.map(({ path }) => path)).not.toContain(canonicalWorktreePath(paths[1]));
    expect(result.refused).toContainEqual(expect.objectContaining({ path: canonicalWorktreePath(paths[1]), reason: "live thread thr_1000" }));
  });

  it("is report-only and defaults to refusing detached worktrees without an inventory verdict", () => {
    const { root } = fixture();
    const result = cleanupGitWorktrees(root, new Set());
    expect(result).not.toHaveProperty("removed");
    expect(result.environmentRecordsReleased).toBe(false);
    expect(result.wouldRemove).toEqual([]);
    // An empty wouldRemove alone cannot tell the inventory gate from the quiet floor, which
    // also refuses this fixture. Only the reason distinguishes the default under test.
    expect(result.refused).toContainEqual(expect.objectContaining({ reason: "bb environment inventory is incomplete; detached ownership unresolved" }));
  });
});
